import {ClientScope} from 'app/client/components/ClientScope';
import * as Clipboard from 'app/client/components/Clipboard';
import {Comm} from 'app/client/components/Comm';
import * as commandList from 'app/client/components/commandList';
import * as commands from 'app/client/components/commands';
import * as Login from 'app/client/components/Login';
import {unsavedChanges} from 'app/client/components/UnsavedChanges';
import {get as getBrowserGlobals} from 'app/client/lib/browserGlobals';
import {isDesktop} from 'app/client/lib/browserInfo';
import * as koUtil from 'app/client/lib/koUtil';
import {reportError, TopAppModel, TopAppModelImpl} from 'app/client/models/AppModel';
import * as DocListModel from 'app/client/models/DocListModel';
import {setUpErrorHandling} from 'app/client/models/errors';
import {createAppUI} from 'app/client/ui/AppUI';
import {attachCssRootVars} from 'app/client/ui2018/cssVars';
import {BaseAPI} from 'app/common/BaseAPI';
import {DisposableWithEvents} from 'app/common/DisposableWithEvents';
import {fetchFromHome} from 'app/common/urlUtils';
import {ISupportedFeatures} from 'app/common/UserConfig';
import {dom, DomElementMethod} from 'grainjs';
import * as ko from 'knockout';

// tslint:disable:no-console

const G = getBrowserGlobals('document', 'window');

type DocListModel = any;
type Login = any;

/**
 * Main Grist App UI component.
 */
export class App extends DisposableWithEvents {
  // Used by #newui code to avoid a dependency on commands.js, and by tests to issue commands.
  public allCommands = commands.allCommands;

  // Whether new UI should be produced by code that can do either old or new.
  public readonly useNewUI: true = true;

  public comm = this.autoDispose(Comm.create());
  public clientScope: ClientScope;
  public features: ko.Computed<ISupportedFeatures>;
  public login: Login;
  public topAppModel: TopAppModel;    // Exposed because used by test/nbrowser/gristUtils.
  public docListModel: DocListModel;

  private _settings: ko.Observable<{features?: ISupportedFeatures}>;

  // Track the version of the server we are communicating with, so that if it changes
  // we can choose to refresh the client also.
  private _serverVersion: string|null = null;

  constructor() {
    super();

    commands.init(); // Initialize the 'commands' module using the default command list.

    // Create the notifications box, and use it for reporting errors we can catch.
    setUpErrorHandling(reportError, koUtil);

    this.clientScope = this.autoDispose(ClientScope.create());

    // Settings, initialized by initSettings event triggered by a server message.
    this._settings = ko.observable({});
    this.features = ko.computed(() => this._settings().features || {});

    // Creates a Login instance which handles building the login form, login/signup, logout,
    // and refreshing tokens. Uses .features, so instantiated after that.
    this.login = this.autoDispose(Login.create(this));

    if (isDesktop()) {
      this.autoDispose(Clipboard.create(this));
    }

    this.topAppModel = this.autoDispose(TopAppModelImpl.create(null, G.window));
    this.docListModel = this.autoDispose(DocListModel.create(this));

    const isHelpPaneVisible = ko.observable(false);

    G.document.querySelector('#grist-logo-wrapper').remove();

    // Help pop-up pane
    const helpDiv = document.body.appendChild(
      dom('div.g-help',
        dom.show(isHelpPaneVisible),
        dom('table.g-help-table',
          dom('thead',
            dom('tr',
              dom('th', 'Key'),
              dom('th', 'Description')
            )
          ),
          dom.forEach(commandList.groups, (group: any) => {
            const cmds = group.commands.filter((cmd: any) => Boolean(cmd.desc && cmd.keys.length));
            return cmds.length > 0 ?
              dom('tbody',
                dom('tr',
                  dom('td', {colspan: 2}, group.group)
                ),
                dom.forEach(cmds, (cmd: any) =>
                  dom('tr',
                    dom('td', commands.allCommands[cmd.name].getKeysDom()),
                    dom('td', cmd.desc)
                  )
                )
              ) : null;
          })
        )
      )
    );
    this.onDispose(() => { dom.domDispose(helpDiv); helpDiv.remove(); });

    this.autoDispose(commands.createGroup({
      help() { G.window.open('help', '_blank').focus(); },
      shortcuts() { isHelpPaneVisible(true); },
      historyBack() { G.window.history.back(); },
      historyForward() { G.window.history.forward(); },
    }, this, true));

    this.autoDispose(commands.createGroup({
      cancel() { isHelpPaneVisible(false); },
      help() { isHelpPaneVisible(false); },
    }, this, isHelpPaneVisible));

    this.listenTo(this.comm, 'clientConnect', (message) => {
      console.log(`App clientConnect event: resetClientId ${message.resetClientId} version ${message.serverVersion}`);
      this._settings(message.settings);
      this.login.updateProfileFromServer(message.profile);
      if (message.serverVersion === 'dead' || (this._serverVersion && this._serverVersion !== message.serverVersion)) {
        console.log("Upgrading...");
        // Server has upgraded.  Upgrade client.  TODO: be gentle and polite.
        return this.reload();
      }
      this._serverVersion = message.serverVersion;
      // If the clientId changed, then we need to reload any open documents. We'll simply reload the
      // active component of the App regardless of what it is.
      if (message.resetClientId) {
        this.reloadPane();
      }
    });

    this.listenTo(this.comm, 'connectState', (isConnected: boolean) => {
      this.topAppModel.notifier.setConnectState(isConnected);
    });

    this.listenTo(this.comm, 'profileFetch', (message) => {
      this.login.updateProfileFromServer(message.data);
    });

    this.listenTo(this.comm, 'clientLogout', () => this.login.onLogout());

    this.listenTo(this.comm, 'docShutdown', () => {
      console.log("Received docShutdown");
      // Reload on next tick, to let other objects process 'docShutdown' before they get disposed.
      setTimeout(() => this.reloadPane(), 0);
    });

    // When the document is unloaded, dispose the app, allowing it to do any needed
    // cleanup (e.g. Document on disposal triggers closeDoc message to the server). It needs to be
    // in 'beforeunload' rather than 'unload', since websocket is closed by the time of 'unload'.
    G.window.addEventListener('beforeunload', (ev: BeforeUnloadEvent) => {
      if (unsavedChanges.haveUnsavedChanges()) {
        // Following https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event
        const msg = 'You have some unsaved changes';
        ev.returnValue = msg;
        ev.preventDefault();
        return msg;
      }
      this.dispose();
    });

    this.comm.initialize(null);

    // Add the cssRootVars class to enable the variables in cssVars.
    attachCssRootVars(this.topAppModel.productFlavor);
    this.autoDispose(createAppUI(this.topAppModel, this));
  }

  // We want to test erors from Selenium, but errors we can trigger using driver.executeScript()
  // will be impossible for the application to report properly (they seem to be considered not of
  // "same-origin"). So this silly callback is for tests to generate a fake error.
  public testTriggerError(msg: string) { throw new Error(msg); }

  public reloadPane() {
    console.log("reloadPane");
    this.topAppModel.reload();
  }

  // When called as a dom method, adds the "newui" class when ?newui=1 is set. For example
  //    dom('div.some-old-class', this.app.addNewUIClass(), ...)
  // Then you may overridde newui styles in CSS by using selectors like:
  //    .some-old-class.newui { ... }
  public addNewUIClass(): DomElementMethod {
    return (elem) => { if (this.useNewUI) { elem.classList.add('newui'); } };
  }

  // Intended to be used by tests to enable specific features.
  public enableFeature(featureName: keyof ISupportedFeatures, onOff: boolean) {
    const features = this.features();
    features[featureName] = onOff;
    this._settings(Object.assign(this._settings(), { features }));
  }

  public getServerVersion() {
    return this._serverVersion;
  }

  public reload() {
    G.window.location.reload(true);
    return true;
  }

  /**
   * Returns the UntrustedContentOrigin use settings. Throws if not defined. The configured
   * UntrustedContentOrign should not include the port, it is defined at runtime.
   */
  public getUntrustedContentOrigin() {

    if (G.window.isRunningUnderElectron) {
      // when loaded within webviews it is safe to serve plugin's content from the same domain
      return "";
    }

    const origin =  G.window.gristConfig.pluginUrl;
    if (!origin) {
      throw new Error("Missing untrustedContentOrigin configuration");
    }
    if (origin.match(/:[0-9]+$/)) {
      // Port number already specified, no need to add.
      return origin;
    }
    return origin + ":" + G.window.location.port;
  }

  // Get the user profile for testing purposes
  public async testGetProfile(): Promise<any> {
    const resp = await fetchFromHome('/api/profile/user', {credentials: 'include'});
    return resp.json();
  }

  public testNumPendingApiRequests(): number {
    return BaseAPI.numPendingRequests();
  }
}
