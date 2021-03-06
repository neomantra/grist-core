/**
 * This module contains various logic for converting columns between types. It is used from
 * TypeTransform.js.
 */
// tslint:disable:no-console

import {DocModel} from 'app/client/models/DocModel';
import {ColumnRec} from 'app/client/models/entities/ColumnRec';
import * as UserType from 'app/client/widgets/UserType';
import * as gristTypes from 'app/common/gristTypes';
import * as gutil from 'app/common/gutil';
import {TableData} from 'app/common/TableData';

export interface ColInfo {
  type: string;
  isFormula: boolean;
  formula: string;
  visibleCol: number;
  widgetOptions?: string;
}

/**
 * Returns the suggested full type for `column` given a desired pure type to convert it to.
 * Specifically, a pure type of "DateTime" returns a full type of "DateTime:{timezone}", and "Ref"
 * returns a full type of "Ref:{TableId}". A `type` that's already complete is returned unchanged.
 */
export function addColTypeSuffix(type: string, column: ColumnRec, docModel: DocModel) {
  switch (type) {
    case "Ref": {
      const refTableId = getRefTableIdFromData(docModel, column) || column.table().primaryTableId();
      return 'Ref:' + refTableId;
    }
    case "DateTime":
      return 'DateTime:' + docModel.docInfo.getRowModel(1).timezone();
    default:
      return type;
  }
}

/**
 * Looks through the data of the given column to find the first value of the form
 * [R, <tableId>, <rowId>] (a Reference value returned from a formula), and returns the tableId
 * from that.
 */
function getRefTableIdFromData(docModel: DocModel, column: ColumnRec): string|null {
  const tableData = docModel.docData.getTable(column.table().tableId());
  const columnData = tableData && tableData.getColValues(column.colId());
  if (columnData) {
    for (const value of columnData) {
      if (gristTypes.isObject(value) && value[0] === 'R') {
        return value[1];
      } else if (typeof value === 'string') {
        // If it looks like a formatted Ref value (e.g. "Table1[123]"), and the tableId is valid,
        // use it. (This helps if a Ref-returning formula column got converted to Text first.)
        const match = value.match(/^(\w+)\[\d+\]/);
        if (match && docModel.docData.getTable(match[1])) {
          return match[1];
        }
      }
    }
  }
  return null;
}


// Given info about the original column, and the type of the new one, returns a promise for the
// ColInfo to use for the transform column. Note that isFormula will be set to true, and formula
// will be set to the expression to compute the new values from the old ones.
// @param toTypeMaybeFull: Type to convert the column to, either full ('Ref:Foo') or pure ('Ref').
export async function prepTransformColInfo(docModel: DocModel, origCol: ColumnRec, origDisplayCol: ColumnRec,
                                           toTypeMaybeFull: string): Promise<ColInfo> {
  const toType = gristTypes.extractTypeFromColType(toTypeMaybeFull);
  const tableData: TableData = docModel.docData.getTable(origCol.table().tableId())!;
  let widgetOptions: any = null;

  const colInfo: ColInfo = {
    type: addColTypeSuffix(toTypeMaybeFull, origCol, docModel),
    isFormula: true,
    visibleCol: 0,
    formula: "",          // Will be filled in at the end.
  };

  switch (toType) {
    case 'Choice': {
      // Set suggested choices. Limit to 100, since too many choices is more likely to cause
      // trouble than desired behavior. For many choices, recommend using a Ref to helper table.
      const columnData = tableData.getDistinctValues(origCol.colId(), 100);
      if (columnData) {
        columnData.delete("");
        widgetOptions = {choices: Array.from(columnData, String)};
      }
      break;
    }
    case 'Ref': {
      // Set suggested destination table and visible column.
      // Null if toTypeMaybeFull is a pure type (e.g. converting to Ref before a table is chosen).
      const optTableId = gutil.removePrefix(toTypeMaybeFull, "Ref:")!;

      // Finds a reference suggestion column and sets it as the current reference value.
      const columnData = tableData.getDistinctValues(origDisplayCol.colId(), 100);
      if (!columnData) { break; }
      columnData.delete(gristTypes.getDefaultForType(origCol.type()));

      // 'findColFromValues' function requires an array since it sends the values to the sandbox.
      const matches: number[] = await docModel.docData.findColFromValues(Array.from(columnData), 2, optTableId);
      const suggestedColRef = matches.find(match => match !== origCol.getRowId());
      if (!suggestedColRef) { break; }
      const suggestedCol = docModel.columns.getRowModel(suggestedColRef);
      const suggestedTableId = suggestedCol.table().tableId();
      if (optTableId && suggestedTableId !== optTableId) {
        console.warn("Inappropriate column received from findColFromValues");
        break;
      }
      colInfo.type = `Ref:${suggestedTableId}`;
      colInfo.visibleCol = suggestedColRef;
      break;
    }
  }

  const newOptions = UserType.mergeOptions(widgetOptions || {}, colInfo.type);
  if (widgetOptions) {
    colInfo.widgetOptions = JSON.stringify(widgetOptions);
  }
  colInfo.formula = getDefaultFormula(docModel, origCol, colInfo.type, colInfo.visibleCol, newOptions);
  return colInfo;
}

// Given the transformCol, calls (if needed) a user action to update its displayCol.
export async function setDisplayFormula(
  docModel: DocModel, transformCol: ColumnRec, visibleCol?: number
): Promise<void> {
  const vcolRef = (visibleCol == null) ? transformCol.visibleCol() : visibleCol;
  if (isReferenceCol(transformCol)) {
    const vcol = getVisibleColName(docModel, vcolRef);
    const tcol = transformCol.colId();
    const displayFormula = (vcolRef === 0 ? '' : `$${tcol}.${vcol}`);
    return transformCol.saveDisplayFormula(displayFormula);
  }
}

// Given the original column and info about the new column, returns the formula to use for the
// transform column to do the transformation.
export function getDefaultFormula(
  docModel: DocModel, origCol: ColumnRec, newType: string,
  newVisibleCol: number, newWidgetOptions: any): string {

  const colId = origCol.colId();
  const oldVisibleColName = isReferenceCol(origCol) ?
    getVisibleColName(docModel, origCol.visibleCol()) : undefined;

  const origValFormula = oldVisibleColName ?
    // The `str()` below converts AltText to plain text.
    `$${colId}.${oldVisibleColName} if ISREF($${colId}) else str($${colId})` :
    `$${colId}`;
  const toTypePure: string = gristTypes.extractTypeFromColType(newType);

  // The args are used to construct the call to grist.TYPE.typeConvert(value, [params]).
  // Optional parameters depend on the type; see sandbox/grist/usertypes.py
  const args: string[] = [origValFormula];
  switch (toTypePure) {
    case 'Ref': {
      const table = gutil.removePrefix(newType, "Ref:");
      args.push(table || 'None');
      const visibleColName = getVisibleColName(docModel, newVisibleCol);
      if (visibleColName) {
        args.push(q(visibleColName));
      }
      break;
    }
    case 'Date': {
      args.push(q(newWidgetOptions.dateFormat));
      break;
    }
    case 'DateTime': {
      const timezone = gutil.removePrefix(newType, "DateTime:") || '';
      const format = newWidgetOptions.dateFormat + ' ' + newWidgetOptions.timeFormat;
      args.push(q(format), q(timezone));
      break;
    }
  }
  return `grist.${gristTypes.getGristType(toTypePure)}.typeConvert(${args.join(', ')})`;
}

function q(value: string): string {
  return "'" + value.replace(/'/g, "\\'") + "'";
}

// Returns the name of the visibleCol given its rowId.
function getVisibleColName(docModel: DocModel, visibleColRef: number): string|undefined {
  return visibleColRef ? docModel.columns.getRowModel(visibleColRef).colId() : undefined;
}

// Returns whether the given column model is of type Ref.
function isReferenceCol(colModel: ColumnRec) {
  return gristTypes.extractTypeFromColType(colModel.type()) === 'Ref';
}
