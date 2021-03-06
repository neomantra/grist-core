import * as commands from 'app/client/components/commands';
import {Cursor} from 'app/client/components/Cursor';
import {GristDoc} from 'app/client/components/GristDoc';
import {UnsavedChange} from 'app/client/components/UnsavedChanges';
import {DataRowModel} from 'app/client/models/DataRowModel';
import {ViewFieldRec} from 'app/client/models/entities/ViewFieldRec';
import {reportError} from 'app/client/models/errors';
import {FormulaEditor} from 'app/client/widgets/FormulaEditor';
import {NewBaseEditor} from 'app/client/widgets/NewBaseEditor';
import {CellValue} from "app/common/DocActions";
import {isRaisedException} from 'app/common/gristTypes';
import * as gutil from 'app/common/gutil';
import {Disposable, Holder, Observable} from 'grainjs';

type IEditorConstructor = typeof NewBaseEditor;
interface ICommandGroup { [cmd: string]: () => void; }

/**
 * Check if the typed-in value should change the cell without opening the cell editor, and if so,
 * saves and returns true. E.g. on typing space, CheckBoxEditor toggles the cell without opening.
 */
export function saveWithoutEditor(
  editorCtor: IEditorConstructor, editRow: DataRowModel, field: ViewFieldRec, typedVal: string|undefined
): boolean {
  // Never skip the editor if editing a formula. Also, check that skipEditor static function
  // exists (we don't bother adding it on old-style JS editors that don't need it).
  if (!field.column.peek().isRealFormula.peek() && editorCtor.skipEditor) {
    const origVal = editRow.cells[field.colId()].peek();
    const skipEditorValue = editorCtor.skipEditor(typedVal, origVal);
    if (skipEditorValue !== undefined) {
      setAndSave(editRow, field, skipEditorValue).catch(reportError);
      return true;
    }
  }
  return false;
}

// Set the given field of editRow to value, only if different from the current value of the cell.
export async function setAndSave(editRow: DataRowModel, field: ViewFieldRec, value: CellValue): Promise<void> {
  const obs = editRow.cells[field.colId()];
  if (value !== obs.peek()) {
    return obs.setAndSave(value);
  }
}

export class FieldEditor extends Disposable {
  private _gristDoc: GristDoc;
  private _field: ViewFieldRec;
  private _cursor: Cursor;
  private _editRow: DataRowModel;
  private _cellRect: ClientRect|DOMRect;
  private _editCommands: ICommandGroup;
  private _editorCtor: IEditorConstructor;
  private _editorHolder: Holder<NewBaseEditor> = Holder.create(this);
  private _saveEditPromise: Promise<boolean>|null = null;

  constructor(options: {
    gristDoc: GristDoc,
    field: ViewFieldRec,
    cursor: Cursor,
    editRow: DataRowModel,
    cellElem: Element,
    editorCtor: IEditorConstructor,
    startVal?: string,
  }) {
    super();
    this._gristDoc = options.gristDoc;
    this._field = options.field;
    this._cursor = options.cursor;
    this._editRow = options.editRow;
    this._editorCtor = options.editorCtor;
    this._cellRect = rectWithoutBorders(options.cellElem);

    const startVal = options.startVal;

    const column = this._field.column();
    let isFormula: boolean, editValue: string|undefined;
    if (startVal && gutil.startsWith(startVal, '=')) {
      // If we entered the cell by typing '=', we immediately convert to formula.
      isFormula = true;
      editValue = gutil.removePrefix(startVal, '=') as string;
    } else {
      // Initially, we mark the field as editing formula if it's a non-empty formula field. This can
      // be changed by typing "=", but the field won't be an actual formula field until saved.
      isFormula = column.isRealFormula.peek();
      editValue = startVal;
    }

    // These are the commands for while the editor is active.
    this._editCommands = {
      // _saveEdit disables this command group, so when we run fieldEditSave again, it triggers
      // another registered group, if any. E.g. GridView listens to it to move the cursor down.
      fieldEditSave: () => {
        this._saveEdit().then((jumped: boolean) => {
          // To avoid confusing cursor movement, do not increment the rowIndex if the row
          // was re-sorted after editing.
          if (!jumped) { commands.allCommands.fieldEditSave.run(); }
        })
        .catch(reportError);
      },
      fieldEditSaveHere: () => { this._saveEdit().catch(reportError); },
      fieldEditCancel: () => { this.dispose(); },
      prevField: () => { this._saveEdit().then(commands.allCommands.prevField.run).catch(reportError); },
      nextField: () => { this._saveEdit().then(commands.allCommands.nextField.run).catch(reportError); },
      makeFormula: () => this._makeFormula(),
      unmakeFormula: () => this._unmakeFormula(),
    };

    this.rebuildEditor(isFormula, editValue, Number.POSITIVE_INFINITY);

    // Whenever focus returns to the Clipboard component, close the editor by saving the value.
    this._gristDoc.app.on('clipboard_focus', this._saveEdit, this);

    // TODO: This should ideally include a callback that returns true only when the editor value
    // has changed. Currently an open editor is considered unsaved even when unchanged.
    UnsavedChange.create(this, async () => { await this._saveEdit(); });

    this.onDispose(() => {
      this._gristDoc.app.off('clipboard_focus', this._saveEdit, this);
      // Unset field.editingFormula flag when the editor closes.
      this._field.editingFormula(false);
    });
  }

  // cursorPos refers to the position of the caret within the editor.
  public rebuildEditor(isFormula: boolean, editValue: string|undefined, cursorPos: number) {
    const editorCtor: IEditorConstructor = isFormula ? FormulaEditor : this._editorCtor;

    const column = this._field.column();
    const cellCurrentValue = this._editRow.cells[this._field.colId()].peek();
    const cellValue = column.isFormula() ? column.formula() : cellCurrentValue;

    // Enter formula-editing mode (e.g. click-on-column inserts its ID) only if we are opening the
    // editor by typing into it (and overriding previous formula). In other cases (e.g. double-click),
    // we defer this mode until the user types something.
    this._field.editingFormula(isFormula && editValue !== undefined);

    let formulaError: Observable<CellValue>|undefined;
    if (column.isFormula() && isRaisedException(cellCurrentValue)) {
      const fv = formulaError = Observable.create(null, cellCurrentValue);
      this._gristDoc.docData.getFormulaError(column.table().tableId(),
        this._field.colId(),
        this._editRow.getRowId()
      )
      .then(value => { fv.set(value); })
      .catch(reportError);
    }

    // Replace the item in the Holder with a new one, disposing the previous one.
    const editor = this._editorHolder.autoDispose(editorCtor.create({
      gristDoc: this._gristDoc,
      field: this._field,
      cellValue,
      formulaError,
      editValue,
      cursorPos,
      commands: this._editCommands,
    }));
    editor.attach(this._cellRect);
  }

  private _makeFormula() {
    const editor = this._editorHolder.get();
    // On keyPress of "=" on textInput, turn the value into a formula.
    if (editor && !this._field.editingFormula.peek() && editor.getCursorPos() === 0) {
      this.rebuildEditor(true, editor.getTextValue(), 0);
      return false;
    }
    return true;    // don't stop propagation.
  }

  private _unmakeFormula() {
    const editor = this._editorHolder.get();
    // Only convert to data if we are undoing a to-formula conversion. To convert formula to
    // data, delete the formula first (which makes the column "empty").
    if (editor && this._field.editingFormula.peek() && editor.getCursorPos() === 0 &&
      !this._field.column().isRealFormula()) {
      // Restore a plain '=' character. This gives a way to enter "=" at the start if line. The
      // second backspace will delete it.
      this.rebuildEditor(false, '=' + editor.getTextValue(), 1);
      return false;
    }
    return true;    // don't stop propagation.
  }

  private async _saveEdit() {
    return this._saveEditPromise || (this._saveEditPromise = this._doSaveEdit());
  }

  // Returns whether the cursor jumped, i.e. current record got reordered.
  private async _doSaveEdit(): Promise<boolean> {
    const editor = this._editorHolder.get();
    if (!editor) { return false; }
    // Make sure the editor is save ready
    const saveIndex = this._cursor.rowIndex();
    await editor.prepForSave();
    if (this.isDisposed()) {
      // We shouldn't normally get disposed here, but if we do, avoid confusing JS errors.
      console.warn("Unable to finish saving edited cell");  // tslint:disable-line:no-console
      return false;
    }

    // Then save the value the appropriate way
    // TODO: this isFormula value doesn't actually reflect if editing the formula, since
    // editingFormula() is used for toggling column headers, and this is deferred to start of
    // typing (a double-click or Enter) does not immediately set it. (This can cause a
    // console.warn below, although harmless.)
    let isFormula = this._field.editingFormula();
    const col = this._field.column();
    let waitPromise: Promise<unknown>|null = null;

    if (isFormula) {
      const formula = editor.getCellValue();
      if (col.isRealFormula() && formula === "") {
        // A somewhat surprising feature: deleting the formula converts the column to data, keeping
        // the values. To clear the column, enter an empty formula again (now into a data column).
        // TODO: this should probably be made more intuitive.
        isFormula = false;
      }

      // Bundle multiple changes so that we can undo them in one step.
      if (isFormula !== col.isFormula.peek() || formula !== col.formula.peek()) {
        waitPromise = this._gristDoc.docData.bundleActions(null, () => Promise.all([
          col.updateColValues({isFormula, formula}),
          // If we're saving a non-empty formula, then also add an empty record to the table
          // so that the formula calculation is visible to the user.
          (this._editRow._isAddRow.peek() && formula !== "" ?
            this._editRow.updateColValues({}) : undefined),
        ]));
      }
    } else {
      const value = editor.getCellValue();
      if (col.isRealFormula()) {
        // tslint:disable-next-line:no-console
        console.warn("It should be impossible to save a plain data value into a formula column");
      } else {
        // This could still be an isFormula column if it's empty (isEmpty is true), but we don't
        // need to toggle isFormula in that case, since the data engine takes care of that.
        waitPromise = setAndSave(this._editRow, this._field, value);
      }
    }
    const cursor = this._cursor;
    // Deactivate the editor. We are careful to avoid using `this` afterwards.
    this.dispose();
    await waitPromise;
    return (saveIndex !== cursor.rowIndex());
  }
}

// Get the bounding rect of elem excluding borders. This allows the editor to match cellElem more
// closely which is more visible in case of DetailView.
function rectWithoutBorders(elem: Element): ClientRect {
  const rect = elem.getBoundingClientRect();
  const style = getComputedStyle(elem, null);
  const bTop = parseFloat(style.getPropertyValue('border-top-width'));
  const bRight = parseFloat(style.getPropertyValue('border-right-width'));
  const bBottom = parseFloat(style.getPropertyValue('border-bottom-width'));
  const bLeft = parseFloat(style.getPropertyValue('border-left-width'));
  return {
    width: rect.width - bLeft - bRight,
    height: rect.height - bTop - bBottom,
    top: rect.top + bTop,
    bottom: rect.bottom - bBottom,
    left: rect.left + bLeft,
    right: rect.right - bRight,
  };
}
