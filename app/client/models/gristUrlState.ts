/**
 * This module provides a urlState() function returning a singleton UrlState, which represents
 * Grist application state as encoded into a URL, and navigation functions.
 *
 * For example, the current org is available as a value or as an observable:
 *
 *    urlState().state.get().org
 *    computed((use) => use(urlState().state).org);
 *
 * Creating a link which has an href but changes state without reloading page is possible with:
 *
 *    dom('a', urlState().setLinkUrl({ws: 10}), "...")
 *
 * Grist URLs have the form:
 *    <org-base>/
 *    <org-base>/ws/<ws>/
 *    <org-base>/doc/<doc>[/p/<docPage>]
 *
 * where <org-base> depends on whether subdomains are in use, i.e. one of:
 *    <org>.getgrist.com
 *    localhost:8080/o/<org>
 *
 * Note that the form of URLs depends on the settings in window.gristConfig object.
 */
import {unsavedChanges} from 'app/client/components/UnsavedChanges';
import {UrlState} from 'app/client/lib/UrlState';
import {decodeUrl, encodeUrl, getSlugIfNeeded, GristLoadConfig, IGristUrlState, useNewUI} from 'app/common/gristUrls';
import {Document} from 'app/common/UserAPI';
import isEmpty = require('lodash/isEmpty');

/**
 * Returns a singleton UrlState object, initializing it on first use.
 */
export function urlState(): UrlState<IGristUrlState> {
  return _urlState || (_urlState = new UrlState(window, new UrlStateImpl(window as any)));
}
let _urlState: UrlState<IGristUrlState>|undefined;

// Returns url parameters appropriate for the specified document, specifically `doc` and `slug`.
export function docUrl(doc: Document): IGristUrlState {
  return {doc: doc.urlId || doc.id, slug: getSlugIfNeeded(doc)};
}

// Returns the home page for the current org.
export function getMainOrgUrl(): string { return urlState().makeUrl({}); }

// When on a document URL, returns the URL with just the doc ID, omitting other bits (like page).
export function getCurrentDocUrl(): string { return urlState().makeUrl({docPage: undefined}); }

// Get url for the login page, which will then redirect to nextUrl (current page by default).
export function getLoginUrl(nextUrl: string = _getCurrentUrl()): string {
  return _getLoginLogoutUrl('login', nextUrl);
}

// Get url for the logout page, which will then redirect to nextUrl (signed-out page by default).
export function getLogoutUrl(nextUrl: string = getSignedOutUrl()): string {
  return _getLoginLogoutUrl('logout', nextUrl);
}

// Get url for the login page, which will then redirect to nextUrl (current page by default).
export function getLoginOrSignupUrl(nextUrl: string = _getCurrentUrl()): string {
  return _getLoginLogoutUrl('signin', nextUrl);
}

// Get url for the reset password page.
export function getResetPwdUrl(): string {
  const startUrl = new URL(window.location.href);
  startUrl.pathname = '/resetPassword';
  return startUrl.href;
}

// Returns the URL for the "you are signed out" page.
export function getSignedOutUrl(): string { return getMainOrgUrl() + "signed-out"; }

// Helper which returns the URL of the current page, except when it's the "/signed-out" page, in
// which case returns the org URL. This is a good URL to use for a post-login redirect.
function _getCurrentUrl(): string {
  return window.location.pathname.endsWith("/signed-out") ? getMainOrgUrl() : window.location.href;
}

// Helper for getLoginUrl()/getLogoutUrl().
function _getLoginLogoutUrl(method: 'login'|'logout'|'signin', nextUrl: string): string {
  const startUrl = new URL(window.location.href);
  startUrl.pathname = '/' + method;
  startUrl.searchParams.set('next', nextUrl);
  return startUrl.href;
}

export type IDocPage = number | 'new' | 'code';

/**
 * Implements the interface expected by UrlState. It is only exported for the sake of tests; the
 * only public interface is the urlState() accessor.
 */
export class UrlStateImpl {
  constructor(private window: {gristConfig?: Partial<GristLoadConfig>}) {}

  /**
   * The actual serialization of a url state into a URL. The URL has the form
   *    <org-base>/
   *    <org-base>/ws/<ws>/
   *    <org-base>/doc/<doc>[/p/<docPage>]
   *    <org-base>/doc/<doc>[/m/fork][/p/<docPage>]
   *
   * where <org-base> depends on whether subdomains are in use, e.g.
   *    <org>.getgrist.com
   *    localhost:8080/o/<org>
   */
  public encodeUrl(state: IGristUrlState, baseLocation: Location | URL): string {
    const gristConfig = this.window.gristConfig || {};
    return encodeUrl(gristConfig, state, baseLocation);
  }

  /**
   * Parse a URL location into an IGristUrlState object. See encodeUrl() documentation.
   */
  public decodeUrl(location: Location | URL): IGristUrlState {
    const gristConfig = this.window.gristConfig || {};
    return decodeUrl(gristConfig, location);
  }

  /**
   * Updates existing state with new state, with attention to Grist-specific meanings.
   * E.g. setting 'docPage' will reuse previous 'doc', but setting 'org' or 'ws' will ignore it.
   */
  public updateState(prevState: IGristUrlState, newState: IGristUrlState): IGristUrlState {
    const keepState = (newState.org || newState.ws || newState.homePage || newState.doc || isEmpty(newState) ||
                       newState.billing || newState.welcome) ?
      (prevState.org ? {org: prevState.org, newui: prevState.newui} : {}) :
      prevState;
    return {...keepState, ...newState};
  }

  /**
   * Billing pages and doc-specific pages for now require a page load.
   * TODO: Make it so doc pages do NOT require a page load, since we are actually serving the same
   * single-page app for home and for docs, and should only need a reload triggered if it's
   * a matter of DocWorker requiring a different version (e.g. /v/OTHER/doc/...).
   */
  public needPageLoad(prevState: IGristUrlState, newState: IGristUrlState): boolean {
    const gristConfig = this.window.gristConfig || {};
    const orgReload = prevState.org !== newState.org;
    // Reload when moving to/from a document or between doc and non-doc.
    const docReload = prevState.doc !== newState.doc;
    // Reload when moving to/from a billing page.
    const billingReload = Boolean(prevState.billing) !== Boolean(newState.billing);
    // Reload when changing 'newui' flag.
    const newuiReload = useNewUI(prevState.newui) !== useNewUI(newState.newui);
    // Reload when moving to/from a welcome page.
    const welcomeReload = Boolean(prevState.welcome) !== Boolean(newState.welcome);
    return Boolean(orgReload || billingReload || gristConfig.errPage || docReload || newuiReload || welcomeReload);
  }

  /**
   * Complete outstanding work before changes that would destroy page state, e.g. if there are
   * edits to be saved.
   */
  public async delayPushUrl(prevState: IGristUrlState, newState: IGristUrlState): Promise<void> {
    if (newState.docPage !== prevState.docPage) {
      return unsavedChanges.saveChanges();
    }
  }
}
