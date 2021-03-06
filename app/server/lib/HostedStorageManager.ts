import * as sqlite3 from '@gristlabs/sqlite3';
import {mapGetOrSet} from 'app/common/AsyncCreate';
import {delay} from 'app/common/delay';
import {DocEntry} from 'app/common/DocListAPI';
import {buildUrlId, parseUrlId} from 'app/common/gristUrls';
import {KeyedOps} from 'app/common/KeyedOps';
import {DocReplacementOptions, NEW_DOCUMENT_CODE} from 'app/common/UserAPI';
import {HomeDBManager} from 'app/gen-server/lib/HomeDBManager';
import {getUserId} from 'app/server/lib/Authorizer';
import {checksumFile} from 'app/server/lib/checksumFile';
import {OptDocSession} from 'app/server/lib/DocSession';
import {DocSnapshotPruner, DocSnapshots} from 'app/server/lib/DocSnapshots';
import {IDocWorkerMap} from 'app/server/lib/DocWorkerMap';
import {ChecksummedExternalStorage, DELETED_TOKEN, ExternalStorage} from 'app/server/lib/ExternalStorage';
import {HostedMetadataManager} from 'app/server/lib/HostedMetadataManager';
import {ICreate} from 'app/server/lib/ICreate';
import {IDocStorageManager} from 'app/server/lib/IDocStorageManager';
import * as log from 'app/server/lib/log';
import {fromCallback} from 'app/server/lib/serverUtils';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as uuidv4 from "uuid/v4";

// Check for a valid document id.
const docIdRegex = /^[-=_\w~%]+$/;

// Wait this long after a change to the document before trying to make a backup of it.
const GRIST_BACKUP_DELAY_SECS = parseInt(process.env.GRIST_BACKUP_DELAY_SECS || '15', 10);

// This constant controls how many pages of the database we back up in a single step.
// The larger it is, the faster the backup overall, but the slower each step is.
// Slower steps result in longer periods when the database is locked, without any
// opportunity for a waiting client to get in and make a write.
// The size of a page, as far as sqlite is concerned, is 4096 bytes.
const PAGES_TO_BACKUP_PER_STEP = 1024;  // Backup is made in 4MB chunks.

// Between steps of the backup, we pause in case a client is waiting to make a write.
// The shorter the pause, the greater the odds that the client won't be able to make
// its write, but the faster the backup will complete.
const PAUSE_BETWEEN_BACKUP_STEPS_IN_MS = 10;

function checkValidDocId(docId: string): void {
  if (!docIdRegex.test(docId)) {
    throw new Error(`Invalid docId ${docId}`);
  }
}

interface HostedStorageOptions {
  secondsBeforePush: number;
  secondsBeforeFirstRetry: number;
  pushDocUpdateTimes: boolean;
  testExternalStorage?: ExternalStorage;
}

const defaultOptions: HostedStorageOptions = {
  secondsBeforePush: GRIST_BACKUP_DELAY_SECS,
  secondsBeforeFirstRetry: 3.0,
  pushDocUpdateTimes: true
};

/**
 * HostedStorageManager manages Grist files in the hosted environment for a particular DocWorker.
 * These files are stored on S3 and synced to the local file system. It matches the interface of
 * DocStorageManager (used for standalone Grist), but is more limited, e.g. does not expose the
 * list of local files.
 *
 * In hosted environment, documents are uniquely identified by docId, which serves as the
 * canonical docName. This ID does not change on renaming. HostedStorageManager knows nothing of
 * friendlier doc names.
 *
 * TODO: Listen (to Redis?) to find out when a local document has been deleted or renamed.
 *  (In case of rename, something on the DocWorker needs to inform the client about the rename)
 * TODO: Do something about the active flag in redis DocStatus.
 * TODO: Add an explicit createFlag in DocStatus for clarity and simplification.
 */
export class HostedStorageManager implements IDocStorageManager {

  // Handles pushing doc metadata changes when the doc is updated.
  private _metadataManager: HostedMetadataManager|null = null;

  // Maps docId to the promise for when the document is present on the local filesystem.
  private _localFiles = new Map<string, Promise<boolean>>();

  // Access external storage.
  private _ext: ChecksummedExternalStorage;

  // Prune external storage.
  private _pruner: DocSnapshotPruner;

  // If _disableS3 is set, don't actually communicate with S3 - keep everything local.
  private _disableS3 = (process.env.GRIST_DISABLE_S3 === 'true');

  // A set of filenames currently being created or downloaded.
  private _prepareFiles = new Set<string>();

  // Ongoing and scheduled uploads for documents.
  private _uploads: KeyedOps;

  // Set once the manager has been closed.
  private _closed: boolean = false;

  private _baseStore: ExternalStorage;  // External store for documents, without checksumming.

  /**
   * Initialize with the given root directory, which should be a fully-resolved path.
   * If s3Bucket is blank, S3 storage will be disabled.
   */
  constructor(
    private _docsRoot: string,
    private _docWorkerId: string,
    s3Bucket: string,
    s3Prefix: string,    // Should end in / if non-empty.
    private _docWorkerMap: IDocWorkerMap,
    dbManager: HomeDBManager,
    create: ICreate,
    options: HostedStorageOptions = defaultOptions
  ) {
    if (s3Bucket === '') { this._disableS3 = true; }
    // We store documents either in a test store, or in an s3 store
    // at s3://<s3Bucket>/<s3Prefix><docId>.grist
    const externalStore = options.testExternalStorage ||
      (this._disableS3 ? undefined : create.ExternalStorage(s3Bucket, s3Prefix));
    if (!externalStore) { this._disableS3 = true; }
    const secondsBeforePush = options.secondsBeforePush;
    const secondsBeforeFirstRetry = options.secondsBeforeFirstRetry;
    if (options.pushDocUpdateTimes) {
      this._metadataManager = new HostedMetadataManager(dbManager);
    }
    this._uploads = new KeyedOps(key => this._pushToS3(key), {
      delayBeforeOperationMs: secondsBeforePush * 1000,
      retry: true,
      logError: (key, failureCount, err) => {
        log.error("HostedStorageManager: error pushing %s (%d): %s", key, failureCount, err);
      }
    });

    if (!this._disableS3) {
      this._baseStore = externalStore!;
      // Whichever store we have, we use checksums to deal with
      // eventual consistency.
      const versions = new Map<string, string>();
      this._ext = new ChecksummedExternalStorage(this._baseStore, {
        maxRetries: 4,
        initialDelayMs: secondsBeforeFirstRetry * 1000,
        computeFileHash: this._getHash.bind(this),
        sharedHash: {
          save: async (key, checksum) => {
            await this._docWorkerMap.updateDocStatus(key, checksum);
          },
          load: async (key) => {
            const docStatus = await this._docWorkerMap.getDocWorker(key);
            return docStatus && docStatus.docMD5 || null;
          }
        },
        localHash: {
          save: async (key, checksum) => {
            const fname = this._getHashFile(this.getPath(key));
            await fse.writeFile(fname, checksum);
          },
          load: async (key) => {
            const fname = this._getHashFile(this.getPath(key));
            if (!await fse.pathExists(fname)) { return null; }
            return await fse.readFile(fname, 'utf8');
          }
        },
        latestVersion: {
          save: async (key, ver) => {
            versions.set(key, ver);
          },
          load: async (key) => versions.get(key) || null
        }
      });
      // The pruner could use an inconsistent store without any real loss overall,
      // but tests are easier if it is consistent.
      this._pruner = new DocSnapshotPruner(this._ext, {
        delayBeforeOperationMs: 0,  // prune as soon as we've made a first upload.
        minDelayBetweenOperationsMs: secondsBeforePush * 4000,  // ... but wait awhile before
                                                                // pruning again.
      });
    }
  }

  /**
   * Send a document to S3, without doing anything fancy.  Assumes this is the first time
   * the object is written in S3 - so no need to worry about consistency.
   */
  public async addToStorage(docId: string) {
    if (this._disableS3) { return; }
    await this._ext.upload(docId, this.getPath(docId));
  }

  public getPath(docName: string): string {
    // docName should just be a docId; we use basename to protect against some possible hack attempts.
    checkValidDocId(docName);
    return path.join(this._docsRoot, `${path.basename(docName, '.grist')}.grist`);
  }

  // We don't deal with sample docs
  public getSampleDocPath(sampleDocName: string): string|null { return null; }

  /**
   * Translates a possibly non-canonical docName to a canonical one. Returns a bare docId,
   * stripping out any possible path components or .grist extension. (We don't expect these to
   * ever be used, but stripping seems better than asserting.)
   */
  public async getCanonicalDocName(altDocName: string): Promise<string> {
    return path.basename(altDocName, '.grist');
  }

  /**
   * Prepares a document for use locally. Here we sync the doc from S3 to the local filesystem.
   * Returns whether the document is new (needs to be created).
   * Calling this method multiple times in parallel for the same document is treated as a sign
   * of a bug.
   */
  public async prepareLocalDoc(docName: string, docSession: OptDocSession): Promise<boolean> {
    // We could be reopening a document that is still closing down.
    // Wait for that to happen.  TODO: we could also try to interrupt the closing-down process.
    await this.closeDocument(docName);

    if (this._prepareFiles.has(docName)) {
      throw new Error(`Tried to call prepareLocalDoc('${docName}') twice in parallel`);
    }

    try {
      this._prepareFiles.add(docName);
      const isNew = !(await this._ensureDocumentIsPresent(docName, docSession));
      return isNew;
    } finally {
      this._prepareFiles.delete(docName);
    }
  }

  // Gets a copy of the document, eg. for downloading.  Returns full file path.
  // Copy won't change if edits are made to the document.  It is caller's responsibility
  // to delete the result.
  public async getCopy(docName: string): Promise<string> {
    const present = await this._ensureDocumentIsPresent(docName, {client: null});
    if (!present) {
      throw new Error('cannot copy document that does not exist yet');
    }
    return await this._prepareBackup(docName, uuidv4());
  }

  public async replace(docId: string, options: DocReplacementOptions): Promise<void> {
    // Make sure the current version of the document is flushed.
    await this.flushDoc(docId);

    // Figure out the source s3 key to copy from.  For this purpose, we need to
    // remove any snapshotId embedded in the document id.
    const rawSourceDocId = options.sourceDocId || docId;
    const parts = parseUrlId(rawSourceDocId);
    const sourceDocId = buildUrlId({...parts, snapshotId: undefined});
    const snapshotId = options.snapshotId || parts.snapshotId;

    if (sourceDocId === docId && !snapshotId) { return; }

    // Basic implementation for when S3 is not available.
    if (this._disableS3) {
      if (snapshotId) {
        throw new Error('snapshots not supported without S3');
      }
      if (await fse.pathExists(this.getPath(sourceDocId))) {
        await fse.copy(this.getPath(sourceDocId), this.getPath(docId));
        return;
      } else {
        throw new Error(`cannot find ${docId}`);
      }
    }

    // While replacing, move the current version of the document aside.  If a problem
    // occurs, move it back.
    const docPath = this.getPath(docId);
    const tmpPath = `${docPath}-replacing`;
    // NOTE: fse.remove succeeds also when the file does not exist.
    await fse.remove(tmpPath);
    if (await fse.pathExists(docPath)) {
      await fse.move(docPath, tmpPath);
    }
    try {
      // Fetch new content from S3.
      if (!await this._fetchFromS3(docId, {sourceDocId, snapshotId})) {
        throw new Error('Cannot fetch document');
      }
      // Make sure the new content is considered new.
      // NOTE: fse.remove succeeds also when the file does not exist.
      await fse.remove(this._getHashFile(this.getPath(docId)));
      this.markAsChanged(docId);
      this.markAsEdited(docId);
    } catch (err) {
      log.error("HostedStorageManager: problem replacing %s: %s", docId, err);
      await fse.move(tmpPath, docPath, {overwrite: true});
      throw err;
    } finally {
      // NOTE: fse.remove succeeds also when the file does not exist.
      await fse.remove(tmpPath);
    }
    // Flush the document immediately if it has been changed.
    await this.flushDoc(docId);
  }

  // We don't deal with listing documents.
  public async listDocs(): Promise<DocEntry[]> { return []; }

  public async deleteDoc(docName: string, deletePermanently?: boolean): Promise<void> {
    if (!deletePermanently) {
      throw new Error("HostedStorageManager only implements permanent deletion in deleteDoc");
    }
    await this.closeDocument(docName);
    if (!this._disableS3) {
      await this._ext.remove(docName);
    }
    // NOTE: fse.remove succeeds also when the file does not exist.
    await fse.remove(this.getPath(docName));
    await fse.remove(this._getHashFile(this.getPath(docName)));
  }

  // We don't implement document renames.
  public async renameDoc(oldName: string, newName: string): Promise<void> {
    throw new Error("HostedStorageManager does not implement renameDoc");
  }

  /**
   * We handle backups by syncing the current version of the file as a new object version in S3,
   * with the requested backupTag as an S3 tag.
   */
  public async makeBackup(docName: string, backupTag: string): Promise<string> {
    // TODO Must implement backups: currently this will prevent open docs that need migration.
    // TODO: This method isn't used by SQLiteDB when migrating DB versions, but probably should be.
    return "I_totally_did_not_back_up_your_document_sorry_not_sorry";
  }

  /**
   * Electron version only. Shows the given doc in the file explorer.
   */
  public async showItemInFolder(docName: string): Promise<void> {
    throw new Error("HostedStorageManager does not implement showItemInFolder");
  }

  /**
   * Close the storage manager.  Make sure any pending changes reach S3 first.
   */
  public async closeStorage(): Promise<void> {
    await this._uploads.wait(() =>  log.info('HostedStorageManager: waiting for closeStorage to finish'));

    // Close metadata manager.
    if (this._metadataManager) { await this._metadataManager.close(); }

    // Finish up everything incoming.  This is most relevant for tests.
    // Wait for any downloads to wind up, since there's no easy way to cancel them.
    while (this._prepareFiles.size > 0) { await delay(100); }
    await Promise.all(this._localFiles.values());

    this._closed = true;
    if (this._ext) { await this._ext.close(); }
    if (this._pruner) { await this._pruner.close(); }
  }

  /**
   * Allow storage manager to be used again - used in tests.
   */
  public testReopenStorage() {
    this._closed = false;
  }

  public async testWaitForPrunes() {
    if (this._pruner) { await this._pruner.wait(); }
  }

  /**
   * Get direct access to the external store - used in tests.
   */
  public testGetExternalStorage(): ExternalStorage {
    return this._baseStore;
  }

  // return true if document is backed up to s3.
  public isSaved(docName: string): boolean {
    return !this._uploads.hasPendingOperation(docName);
  }

  // pick up the pace of pushing to s3, from leisurely to urgent.
  public prepareToCloseStorage() {
    if (this._pruner) {
      this._pruner.close().catch(e => log.error("HostedStorageManager: pruning error %s", e));
    }
    this._uploads.expediteOperations();
  }

  /**
   * Finalize any operations involving the named document.
   */
  public async closeDocument(docName: string): Promise<void> {
    if (this._localFiles.has(docName)) {
      await this._localFiles.get(docName);
    }
    this._localFiles.delete(docName);
    return this.flushDoc(docName);
  }

  /**
   * Make sure document is backed up to s3.
   */
  public async flushDoc(docName: string): Promise<void> {
    while (!this.isSaved(docName)) {
      log.info('HostedStorageManager: waiting for document to finish: %s', docName);
      await this._uploads.expediteOperationAndWait(docName);
    }
  }

  /**
   * This is called when a document may have been changed, via edits or migrations etc.
   */
  public markAsChanged(docName: string): void {
    if (parseUrlId(docName).snapshotId) { return; }
    if (this._localFiles.has(docName)) {
      // Make sure the file is marked as locally present (it may be newly created).
      this._localFiles.set(docName, Promise.resolve(true));
    }
    if (this._disableS3) { return; }
    if (this._closed) { throw new Error("HostedStorageManager.markAsChanged called after closing"); }
    this._uploads.addOperation(docName);
  }

  /**
   * This is called when a document was edited by the user.
   */
  public markAsEdited(docName: string): void {
    if (parseUrlId(docName).snapshotId) { return; }
    // Schedule a metadata update for the modified doc.
    if (this._metadataManager) { this._metadataManager.scheduleUpdate(docName); }
  }

  /**
   * Check if there is a pending change to be pushed to S3.
   */
  public needsUpdate(): boolean {
    return this._uploads.hasPendingOperations();
  }

  public async getSnapshots(docName: string): Promise<DocSnapshots> {
    if (this._disableS3) {
      return {
        snapshots: [{
          snapshotId: 'current',
          lastModified: new Date(),
          docId: docName,
        }]
      };
    }
    const versions = await this._ext.versions(docName);
    const parts = parseUrlId(docName);
    return {
      snapshots: versions
        .map(v => ({
          lastModified: v.lastModified,
          snapshotId: v.snapshotId,
          docId: buildUrlId({...parts, snapshotId: v.snapshotId}),
        }))
    };
  }

  /**
   * Makes sure a document is present locally, fetching it from S3 if necessary.
   * Returns true on success, false if document not found.  It is safe to call
   * this method multiple times in parallel.
   */
  private async _ensureDocumentIsPresent(docName: string,
                                         docSession: OptDocSession): Promise<boolean> {
    // AsyncCreate.mapGetOrSet ensures we don't start multiple promises to talk to S3/Redis
    // and that we clean up the failed key in case of failure.
    return mapGetOrSet(this._localFiles, docName, async () => {
      if (this._closed) { throw new Error("HostedStorageManager._ensureDocumentIsPresent called after closing"); }
      checkValidDocId(docName);

      const {trunkId, forkId, forkUserId, snapshotId} = parseUrlId(docName);

      // If forkUserId is set to a valid user id, we can only create a fork if we know the
      // requesting user and their id matches the forkUserId.
      const userId = (docSession.client && docSession.client.getCachedUserId()) ||
        (docSession.req && getUserId(docSession.req));
      const canCreateFork = forkUserId ? (forkUserId === userId) : true;

      const docStatus = await this._docWorkerMap.getDocWorkerOrAssign(docName, this._docWorkerId);
      if (!docStatus.isActive) { throw new Error(`Doc is not active on a DocWorker: ${docName}`); }
      if (docStatus.docWorker.id !== this._docWorkerId) {
        throw new Error(`Doc belongs to a different DocWorker (${docStatus.docWorker.id}): ${docName}`);
      }

      if (this._disableS3) {
        // skip S3, just use file system
        let present: boolean = await fse.pathExists(this.getPath(docName));
        if (forkId && !present) {
          if (!canCreateFork) { throw new Error(`Cannot create fork`); }
          if (snapshotId && snapshotId !== 'current') {
            throw new Error(`cannot find snapshot ${snapshotId} of ${docName}`);
          }
          if (await fse.pathExists(this.getPath(trunkId))) {
            await fse.copy(this.getPath(trunkId), this.getPath(docName));
            present = true;
          }
        }
        return present;
      }

      const existsLocally = await fse.pathExists(this.getPath(docName));
      if (existsLocally) {
        if (!docStatus.docMD5 || docStatus.docMD5 === DELETED_TOKEN) {
          // New doc appears to already exist, but not in S3 (according to redis).
          // Go ahead and use local version.
          return true;
        } else {
          // Doc exists locally and in S3 (according to redis).
          // Make sure the checksum matches.
          const checksum = await this._getHash(await this._prepareBackup(docName));
          if (checksum === docStatus.docMD5) {
            // Fine, accept the doc as existing on our file system.
            return true;
          } else {
            log.info("Local hash does not match redis: %s vs %s", checksum, docStatus.docMD5);
            // The file that exists locally does not match S3.  But S3 is the canonical version.
            // On the assumption that the local file is outdated, delete it.
            // TODO: may want to be more careful in case the local file has modifications that
            // simply never made it to S3 due to some kind of breakage.
            // NOTE: fse.remove succeeds also when the file does not exist.
            await fse.remove(this.getPath(docName));
          }
        }
      }
      return this._fetchFromS3(docName, {
        trunkId: forkId ? trunkId : undefined, snapshotId, canCreateFork
      });
    });
  }

  /**
   * Fetch a document from s3 and save it locally as destId.grist
   *
   * If the document is not present in s3:
   *  + If it has a trunk:
   *    - If we do not not have permission to create a fork, we throw an error
   *    - Else we fetch the document from the trunk instead
   *  + Otherwise return false
   *
   * Forks of fork will not spark joy at this time.  An attempt to
   * fork a fork will result in a new fork of the original trunk.
   */
  private async _fetchFromS3(destId: string, options: {sourceDocId?: string,
                                                       trunkId?: string,
                                                       snapshotId?: string,
                                                       canCreateFork?: boolean}): Promise<boolean> {
    const destIdWithoutSnapshot = buildUrlId({...parseUrlId(destId), snapshotId: undefined});
    let sourceDocId = options.sourceDocId || destIdWithoutSnapshot;
    if (!await this._ext.exists(destIdWithoutSnapshot)) {
      if (!options.trunkId) { return false; }   // Document not found in S3
      // No such fork in s3 yet, try from trunk (if we are allowed to create the fork).
      if (!options.canCreateFork) { throw new Error('Cannot create fork'); }
      // The special NEW_DOCUMENT_CODE trunk means we should create an empty document.
      if (options.trunkId === NEW_DOCUMENT_CODE) { return false; }
      if (!await this._ext.exists(options.trunkId)) { throw new Error('Cannot find original'); }
      sourceDocId = options.trunkId;
    }
    await this._ext.downloadTo(sourceDocId, destId, this.getPath(destId), options.snapshotId);
    return true;
  }

  /**
   * Get a checksum for the given file (absolute path).
   */
  private _getHash(srcPath: string): Promise<string> {
    return checksumFile(srcPath, 'md5');
  }

  /**
   * We'll save hashes in a file with the suffix -hash.
   */
  private _getHashFile(docPath: string): string {
    return docPath + "-hash";
  }

  /**
   * Makes a copy of a document to a file with the suffix -backup.  The copy is
   * made using Sqlite's backup API.  The backup is made incrementally so the db
   * is never locked for long by the backup.  The backup process will survive
   * transient locks on the db.
   */
  private async _prepareBackup(docId: string, postfix: string = 'backup'): Promise<string> {
    const docPath = this.getPath(docId);
    const tmpPath = `${docPath}-${postfix}`;
    return backupSqliteDatabase(docPath, tmpPath, undefined, postfix);
  }

  /**
   * Send a document to S3.
   */
  private async _pushToS3(docId: string): Promise<void> {
    let tmpPath: string|null = null;

    try {
      if (this._prepareFiles.has(docId)) {
        throw new Error('too soon to consider pushing');
      }
      tmpPath = await this._prepareBackup(docId);
      await this._ext.upload(docId, tmpPath);
      this._pruner.requestPrune(docId);
    } finally {
      // Clean up backup.
      // NOTE: fse.remove succeeds also when the file does not exist.
      if (tmpPath) { await fse.remove(tmpPath); }
    }
  }
}


/**
 * Make a copy of a sqlite database safely and without locking it for long periods, using the
 * sqlite backup api.
 * @param src: database to copy
 * @param dest: file to which we copy the database
 * @param testProgress: a callback used for test purposes to monitor detailed timing of backup.
 * @param label: a tag to add to log messages
 * @return dest
 */
export async function backupSqliteDatabase(src: string, dest: string,
                                           testProgress?: (e: BackupEvent) => void,
                                           label?: string): Promise<string> {
  log.debug(`backupSqliteDatabase: starting copy of ${src} (${label})`);
  let db: sqlite3.DatabaseWithBackup|null = null;
  let success: boolean = false;
  try {
    // NOTE: fse.remove succeeds also when the file does not exist.
    await fse.remove(dest);  // Just in case some previous process terminated very badly.
                             // Sqlite will try to open any existing material at this
                             // path prior to overwriting it.
    await fromCallback(cb => { db = new sqlite3.Database(dest, cb) as sqlite3.DatabaseWithBackup; });
    // Turn off protections that can slow backup steps.  If the app or OS
    // crashes, the backup may be corrupt.  In Grist use case, if app or OS
    // crashes, no use will be made of backup, so we're OK.
    // This sets flags matching the --async option to .backup in the sqlite3
    // shell program: https://www.sqlite.org/src/info/7b6a605b1883dfcb
    await fromCallback(cb => db!.exec("PRAGMA synchronous=OFF; PRAGMA journal_mode=OFF;", cb));
    if (testProgress) { testProgress({action: 'open', phase: 'before'}); }
    const backup: sqlite3.Backup = db!.backup(src, 'main', 'main', false);
    if (testProgress) { testProgress({action: 'open', phase: 'after'}); }
    let remaining: number = -1;
    let prevError: Error|null = null;
    let errorMsgTime: number = 0;
    let restartMsgTime: number = 0;
    for (;;) {
      // For diagnostic purposes, issue a message if the backup appears to have been
      // restarted by sqlite.  The symptom of a restart we use is that the number of
      // pages remaining in the backup increases rather than decreases.  That number
      // is reported by backup.remaining (after an initial period of where sqlite
      // doesn't yet know how many pages there are and reports -1).
      // So as not to spam the log if the user is making a burst of changes, we report
      // this message at most once a second.
      // See https://www.sqlite.org/c3ref/backup_finish.html and
      // https://github.com/mapbox/node-sqlite3/pull/1116 for api details.
      if (remaining >= 0 && backup.remaining > remaining && Date.now() - restartMsgTime > 1000) {
        log.info(`backupSqliteDatabase: copy of ${src} (${label}) restarted`);
        restartMsgTime = Date.now();
      }
      remaining = backup.remaining;
      if (testProgress) { testProgress({action: 'step', phase: 'before'}); }
      let isCompleted: boolean = false;
      try {
        isCompleted = Boolean(await fromCallback(cb => backup.step(PAGES_TO_BACKUP_PER_STEP, cb)));
      } catch (err) {
        if (String(err) !== String(prevError) || Date.now() - errorMsgTime > 1000) {
          log.info(`backupSqliteDatabase (${src} ${label}): ${err}`);
          errorMsgTime = Date.now();
        }
        prevError = err;
        if (backup.failed) { throw new Error(`backupSqliteDatabase (${src} ${label}): internal copy failed`); }
      }
      if (testProgress) { testProgress({action: 'step', phase: 'after'}); }
      if (isCompleted) {
        log.info(`backupSqliteDatabase: copy of ${src} (${label}) completed successfully`);
        success = true;
        break;
      }
      await delay(PAUSE_BETWEEN_BACKUP_STEPS_IN_MS);
    }
  } finally {
    if (testProgress) { testProgress({action: 'close', phase: 'before'}); }
    try {
      if (db) { await fromCallback(cb => db!.close(cb)); }
    } catch (err) {
      log.debug(`backupSqliteDatabase: problem stopping copy of ${src} (${label}): ${err}`);
    }
    if (!success) {
      // Something went wrong, remove backup if it was started.
      try {
        // NOTE: fse.remove succeeds also when the file does not exist.
        await fse.remove(dest);
      } catch (err) {
        log.debug(`backupSqliteDatabase: problem removing copy of ${src} (${label}): ${err}`);
      }
    }
    if (testProgress) { testProgress({action: 'close', phase: 'after'}); }
    log.debug(`backupSqliteDatabase: stopped copy of ${src} (${label})`);
  }
  return dest;
}


/**
 * A summary of an event during a backup.  Emitted for test purposes, to check timing.
 */
export interface BackupEvent {
  action: 'step' | 'close' | 'open';
  phase: 'before' | 'after';
}
