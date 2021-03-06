/**
 * Exports `docBreadcrumbs()` which returns a styled breadcrumb for the current page:
 *
 *  [icon] Workspace (link) / Document name (editable) / Page name (editable)
 *
 * Workspace is a clickable link and document and page names are editable labels.
 */
import { urlState } from 'app/client/models/gristUrlState';
import { colors, testId } from 'app/client/ui2018/cssVars';
import { editableLabel } from 'app/client/ui2018/editableLabel';
import { icon } from 'app/client/ui2018/icons';
import { BindableValue, dom, Observable, styled } from 'grainjs';
import { tooltip } from 'popweasel';

export const cssBreadcrumbs = styled('div', `
  color: ${colors.slate};
  white-space: nowrap;
  cursor: default;
`);

export const cssBreadcrumbsLink = styled('a', `
  color: ${colors.lightGreen};
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`);

export const separator = styled('span', `
  padding: 0 2px;
`);

const cssIcon = styled(icon, `
  background-color: ${colors.lightGreen};
  margin-top: -2px;
`);

const cssPublicIcon = styled(cssIcon, `
  margin-left: 8px;
  margin-top: -4px;
`);

const cssWorkspaceName = styled(cssBreadcrumbsLink, `
  margin-left: 8px;
`);

const cssEditableName = styled('input', `
  &:hover, &:focus {
    color: ${colors.dark};
  }
`);

const cssTag = styled('span', `
  background-color: ${colors.slate};
  color: white;
  border-radius: 3px;
  padding: 0 4px;
  margin-left: 4px;
`);

interface PartialWorkspace {
  id: number;
  name: string;
}

const fiddleExplanation = (
  'You may make edits, but they will create a new copy and will\n' +
    'not affect the original document.'
);

export function docBreadcrumbs(
  workspace: Observable<PartialWorkspace|null>,
  docName: Observable<string>,
  pageName: Observable<string>,
  options: {
    docNameSave: (val: string) => Promise<void>,
    pageNameSave: (val: string) => Promise<void>,
    isDocNameReadOnly?: BindableValue<boolean>,
    isPageNameReadOnly?: BindableValue<boolean>,
    isFork: Observable<boolean>,
    isFiddle: Observable<boolean>,
    isSnapshot?: Observable<boolean>,
    isPublic?: Observable<boolean>,
  }
  ): Element {
    return cssBreadcrumbs(
      cssIcon('Home'),
      dom.maybe(workspace, _workspace => [
        cssWorkspaceName(
          urlState().setLinkUrl({ws: _workspace.id}),
          dom.text(_workspace.name),
          testId('bc-workspace')
        ),
        separator(' / ')
      ]),
      editableLabel(
        docName, options.docNameSave, testId('bc-doc'), cssEditableName.cls(''),
        dom.boolAttr('disabled', options.isDocNameReadOnly || false),
      ),
      dom.maybe(options.isPublic, () => cssPublicIcon('PublicFilled', testId('bc-is-public'))),
      dom.domComputed((use) => {
        if (options.isSnapshot && use(options.isSnapshot)) {
          return cssTag('snapshot', testId('snapshot-tag'));
        }
        if (use(options.isFork)) {
          return cssTag('unsaved', testId('unsaved-tag'));
        }
        if (use(options.isFiddle)) {
          return cssTag('fiddle', tooltip({title: fiddleExplanation}), testId('fiddle-tag'));
        }
      }),
      separator(' / '),
      editableLabel(
        pageName, options.pageNameSave, testId('bc-page'), cssEditableName.cls(''),
        dom.boolAttr('disabled', options.isPageNameReadOnly || false),
      ),
    );
}
