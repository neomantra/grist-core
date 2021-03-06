"""
schema.py defines the schema of the tables describing Grist's own data structures. While users can
create tables, add and remove columns, etc, Grist stores various document metadata (about the
users' tables, views, etc.) also in tables.

Before changing this file, please review:
  https://phab.getgrist.com/w/migrations/

"""

import itertools
from collections import OrderedDict, namedtuple
import actions

SCHEMA_VERSION = 20

def make_column(col_id, col_type, formula='', isFormula=False):
  return {
    "id": col_id,
    "type": col_type,
    "isFormula": isFormula,
    "formula": formula
  }

def schema_create_actions():
  return [
    # The document-wide metadata. It's all contained in a single record with id=1.
    actions.AddTable("_grist_DocInfo", [
      make_column("docId",        "Text"), # DEPRECATED: docId is now stored in _gristsys_FileInfo
      make_column("peers",        "Text"), # DEPRECATED: now _grist_ACLPrincipals is used for this

      # Basket id of the document for online storage, if a Basket has been created for it.
      make_column("basketId",     "Text"),

      # Version number of the document. It tells us how to migrate it to reach SCHEMA_VERSION.
      make_column("schemaVersion", "Int"),

      # Document timezone.
      make_column("timezone", "Text"),
    ]),

    # The names of the user tables. This does NOT include built-in tables.
    actions.AddTable("_grist_Tables", [
      make_column("tableId",      "Text"),
      make_column("primaryViewId","Ref:_grist_Views"),

      # For a summary table, this points to the corresponding source table.
      make_column("summarySourceTable", "Ref:_grist_Tables"),

      # A table may be marked as "onDemand", which will keep its data out of the data engine, and
      # only available to the frontend when requested.
      make_column("onDemand",     "Bool")
    ]),

    # All columns in all user tables.
    actions.AddTable("_grist_Tables_column", [
      make_column("parentId",     "Ref:_grist_Tables"),
      make_column("parentPos",    "PositionNumber"),
      make_column("colId",        "Text"),
      make_column("type",         "Text"),
      make_column("widgetOptions","Text"), # JSON extending column's widgetOptions
      make_column("isFormula",    "Bool"),
      make_column("formula",      "Text"),
      make_column("label",        "Text"),

      # Normally a change to label changes colId as well, unless untieColIdFromLabel is True.
      # (We intentionally pick a variable whose default value is false.)
      make_column("untieColIdFromLabel", "Bool"),

      # For a group-by column in a summary table, this points to the corresponding source column.
      make_column("summarySourceCol", "Ref:_grist_Tables_column"),
      # Points to a display column, if it exists, for this column.
      make_column("displayCol",       "Ref:_grist_Tables_column"),
      # For Ref cols only, points to the column in the pointed-to table, which is to be displayed.
      # E.g. Foo.person may have a visibleCol pointing to People.Name, with the displayCol
      # pointing to Foo._gristHelper_DisplayX column with the formula "$person.Name".
      make_column("visibleCol",       "Ref:_grist_Tables_column"),
    ]),

    # DEPRECATED: Previously used to keep import options, and allow the user to change them.
    actions.AddTable("_grist_Imports", [
      make_column("tableRef",     "Ref:_grist_Tables"),
      make_column("origFileName", "Text"),
      make_column("parseFormula", "Text", isFormula=True,
                  formula="grist.parseImport(rec, table._engine)"),

      # The following translate directly to csv module options. We can use csv.Sniffer to guess
      # them based on a sample of the data (it also guesses hasHeaders option).
      make_column("delimiter",    "Text",     formula="','"),
      make_column("doublequote",  "Bool",     formula="True"),
      make_column("escapechar",   "Text"),
      make_column("quotechar",    "Text",     formula="'\"'"),
      make_column("skipinitialspace", "Bool"),

      # Other parameters Grist understands.
      make_column("encoding",     "Text",     formula="'utf8'"),
      make_column("hasHeaders",   "Bool"),
    ]),

    # DEPRECATED: Previously - All external database credentials attached to the document
    actions.AddTable("_grist_External_database", [
      make_column("host",         "Text"),
      make_column("port",         "Int"),
      make_column("username",     "Text"),
      make_column("dialect",      "Text"),
      make_column("database",     "Text"),
      make_column("storage",      "Text"),
    ]),

    # DEPRECATED: Previously - Reference to a table from an external database
    actions.AddTable("_grist_External_table", [
      make_column("tableRef",     "Ref:_grist_Tables"),
      make_column("databaseRef",  "Ref:_grist_External_database"),
      make_column("tableName",    "Text"),
    ]),

    # Document tabs that represent a cross-reference between Tables and Views
    actions.AddTable("_grist_TableViews", [
      make_column("tableRef",     "Ref:_grist_Tables"),
      make_column("viewRef",      "Ref:_grist_Views"),
    ]),

    # DEPRECATED: Previously used to cross-reference between Tables and Views
    actions.AddTable("_grist_TabItems", [
      make_column("tableRef",     "Ref:_grist_Tables"),
      make_column("viewRef",      "Ref:_grist_Views"),
    ]),

    actions.AddTable("_grist_TabBar", [
      make_column("viewRef",      "Ref:_grist_Views"),
      make_column("tabPos",        "PositionNumber"),
    ]),

    # Table for storing the tree of pages. 'pagePos' and 'indentation' columns gives how a page is
    # shown in the panel: 'pagePos' determines the page overall position when no pages are collapsed
    # (ie: all pages are visible) and 'indentation' gives the level of nesting (depth). Note that
    # the parent-child relationships between pages have to be inferred from the variation of
    # `indentation` between consecutive pages. For instance a difference of +1 between two
    # consecutive pages means that the second page is the child of the first page. A difference of 0
    # means that both are siblings and a difference of -1 means that the second page is a sibling to
    # the first page parent.
    actions.AddTable("_grist_Pages", [
      make_column("viewRef", "Ref:_grist_Views"),
      make_column("indentation", "Int"),
      make_column("pagePos", "PositionNumber"),
    ]),

    # All user views.
    actions.AddTable("_grist_Views", [
      make_column("name",         "Text"),
      make_column("type",         "Text"),    # TODO: Should this be removed?
      make_column("layoutSpec",   "Text"),    # JSON string describing the view layout
    ]),

    # The sections of user views (e.g. a view may contain a list section and a detail section).
    # Different sections may need different parameters, so this table includes columns for all
    # possible parameters, and any given section will use some subset, depending on its type.
    actions.AddTable("_grist_Views_section", [
      make_column("tableRef",           "Ref:_grist_Tables"),
      make_column("parentId",           "Ref:_grist_Views"),
      # parentKey is the type of view section, such as 'list', 'detail', or 'single'.
      # TODO: rename this (e.g. to "sectionType").
      make_column("parentKey",          "Text"),
      make_column("title",              "Text"),
      make_column("defaultWidth",       "Int", formula="100"),
      make_column("borderWidth",        "Int", formula="1"),
      make_column("theme",              "Text"),
      make_column("options",            "Text"),
      make_column("chartType",          "Text"),
      make_column("layoutSpec",         "Text"), # JSON string describing the record layout
      # filterSpec is deprecated as of version 15. Do not remove or reuse.
      make_column("filterSpec",         "Text"),
      make_column("sortColRefs",        "Text"),
      make_column("linkSrcSectionRef",  "Ref:_grist_Views_section"),
      make_column("linkSrcColRef",      "Ref:_grist_Tables_column"),
      make_column("linkTargetColRef",   "Ref:_grist_Tables_column"),
      # embedId is deprecated as of version 12. Do not remove or reuse.
      make_column("embedId",            "Text"),
    ]),
    # The fields of a view section.
    actions.AddTable("_grist_Views_section_field", [
      make_column("parentId",     "Ref:_grist_Views_section"),
      make_column("parentPos",    "PositionNumber"),
      make_column("colRef",       "Ref:_grist_Tables_column"),
      make_column("width",        "Int"),
      make_column("widgetOptions","Text"), # JSON extending field's widgetOptions
      # Points to a display column, if it exists, for this field.
      make_column("displayCol",   "Ref:_grist_Tables_column"),
      # For Ref cols only, may override the column to be displayed fromin the pointed-to table.
      make_column("visibleCol",   "Ref:_grist_Tables_column"),
      # JSON string describing the default filter as map from either an `included` or an
      # `excluded` string to an array of column values:
      # Ex1: { included: ['foo', 'bar'] }
      # Ex2: { excluded: ['apple', 'orange'] }
      make_column("filter",       "Text")
    ]),

    # The code for all of the validation rules available to a Grist document
    actions.AddTable("_grist_Validations", [
      make_column("formula",      "Text"),
      make_column("name",         "Text"),
      make_column("tableRef",     "Int")
    ]),

    # The input code and output text and compilation/runtime errors for usercode
    actions.AddTable("_grist_REPL_Hist", [
      make_column("code",         "Text"),
      make_column("outputText",   "Text"),
      make_column("errorText",    "Text")
    ]),

    # All of the attachments attached to this document.
    actions.AddTable("_grist_Attachments", [
      make_column("fileIdent",    "Text"), # Checksum of the file contents. It identifies the file
                                           # data in the _gristsys_Files table.
      make_column("fileName",     "Text"), # User defined file name
      make_column("fileType",     "Text"), # A string indicating the MIME type of the data
      make_column("fileSize",     "Int"),  # The size in bytes
      make_column("imageHeight",  "Int"),  # height in pixels
      make_column("imageWidth",   "Int"),  # width in pixels
      make_column("timeUploaded", "DateTime")
    ]),


    # All of the ACL rules.
    actions.AddTable('_grist_ACLRules', [
      make_column('resource',     'Ref:_grist_ACLResources'),
      make_column('permissions',  'Int'),     # Bit-map of permission types. See acl.py.
      make_column('principals',   'Text'),    # JSON array of _grist_ACLPrincipals refs.

      make_column('aclFormula',   'Text'),    # Formula to apply to tableId, which should return
                                              # additional principals for each row.
      make_column('aclColumn',    'Ref:_grist_Tables_column')
    ]),

    actions.AddTable('_grist_ACLResources', [
      make_column('tableId',      'Text'),    # Name of the table this rule applies to, or ''
      make_column('colIds',       'Text'),    # Comma-separated list of colIds, or ''
    ]),

    # All of the principals used by ACL rules, including users, groups, and instances.
    actions.AddTable('_grist_ACLPrincipals', [
      make_column('type',         'Text'),    # 'user', 'group', or 'instance'
      make_column('userEmail',    'Text'),    # For 'user' principals
      make_column('userName',     'Text'),    # For 'user' principals
      make_column('groupName',    'Text'),    # For 'group' principals
      make_column('instanceId',   'Text'),    # For 'instance' principals

      # docmodel.py defines further `name` and `allInstances`, and members intended as helpers
      # only: `memberships`, `children`, and `descendants`.
    ]),

    # Table for containment relationships between Principals, e.g. user contains multiple
    # instances, group contains multiple users, and groups may contain other groups.
    actions.AddTable('_grist_ACLMemberships', [
      make_column('parent', 'Ref:_grist_ACLPrincipals'),
      make_column('child',  'Ref:_grist_ACLPrincipals'),
    ]),

    # TODO:
    # The Data Engine should not load up the action log or be able to modify it, or know anything
    # about it. It's bad if users could hack up data engine logic to mess with history. (E.g. if
    # share a doc for editing, and peer tries to hack it, want to know that can revert; i.e. peer
    # shouldn't be able to destroy history.) Also, the action log could be big. It's nice to keep
    # it in sqlite and not take up memory.
    #
    # For this reason, JS code perhaps should be the one creating action tables for a new
    # document. It should also ignore any actions that attempt to change such tables. I.e. it
    # should have some protected tables, perhaps with a different prefix (_gristsys_), which can't
    # be changed by actions generated from the data engine.
    #
    # TODO
    # Conversion of schema actions to metadata-change actions perhaps should also be done by JS,
    # and metadata tables should be protected (i.e. can't be changed by user). Hmm....

    # # The actions that fully determine the history of this database.
    # actions.AddTable("_grist_Action", [
    #   make_column("num",          "Int"),       # Action-group number
    #   make_column("time",         "Int"),       # Milliseconds since Epoch
    #   make_column("user",         "Text"),      # User performing this action
    #   make_column("desc",         "Text"),      # Action description
    #   make_column("otherId",      "Int"),       # For Undo and Redo, id of the other action
    #   make_column("linkId",       "Int"),       # Id of the prev action in the same bundle
    #   make_column("json",         "Text"),      # JSON representation of the action
    # ]),

    # # A logical action is comprised potentially of multiple steps.
    # actions.AddTable("_grist_Action_step", [
    #   make_column("parentId",     "Ref:_grist_Action"),
    #   make_column("type",         "Text"),      # E.g. "undo", "stored"
    #   make_column("name",         "Text"),      # E.g. "AddRecord" or "RenameTable"
    #   make_column("tableId",      "Text"),      # Name of the table
    #   make_column("colIds",       "Text"),      # Comma-separated names of affected columns
    #   make_column("rowIds",       "Text"),      # Comma-separated IDs of affected rows
    #   make_column("values",       "Text"),      # All values for the affected rows and columns,
    #                                             # bundled together, column-wise, as a JSON array.
    # ]),
  ]


# These are little structs to represent the document schema that's used in code generation.
# Schema itself (as stored by Engine) is an OrderedDict(tableId -> SchemaTable), with
# SchemaTable.columns being an OrderedDict(colId -> SchemaColumn).
SchemaTable = namedtuple('SchemaTable', ('tableId', 'columns'))
SchemaColumn = namedtuple('SchemaColumn', ('colId', 'type', 'isFormula', 'formula'))

# Helpers to convert between schema structures and dicts used in schema actions.
def dict_to_col(col, col_id=None):
  """Convert dict as used in AddColumn/AddTable actions to a SchemaColumn object."""
  return SchemaColumn(col_id or col["id"], col["type"], bool(col["isFormula"]), col["formula"])

def col_to_dict(col, include_id=True):
  """Convert SchemaColumn to dict to use in AddColumn/AddTable actions."""
  ret = {"type": col.type, "isFormula": col.isFormula, "formula": col.formula}
  if include_id:
    ret["id"] = col.colId
  return ret

def dict_list_to_cols(dict_list):
  """Convert list of column dicts to an OrderedDict of SchemaColumns."""
  return OrderedDict((c["id"], dict_to_col(c)) for c in dict_list)

def cols_to_dict_list(cols):
  """Convert OrderedDict of SchemaColumns to an array of column dicts."""
  return [col_to_dict(c) for c in cols.values()]

def clone_schema(schema):
  return OrderedDict((t, SchemaTable(s.tableId, s.columns.copy()))
                     for (t, s) in schema.iteritems())

def build_schema(meta_tables, meta_columns, include_builtin=True):
  """
  Arguments are TableData objects for the _grist_Tables and _grist_Tables_column tables.
  Returns the schema object for engine.py, used in particular in gencode.py.
  """
  assert meta_tables.table_id == '_grist_Tables'
  assert meta_columns.table_id == '_grist_Tables_column'

  # Schema is an OrderedDict.
  schema = OrderedDict()
  if include_builtin:
    for t in schema_create_actions():
      schema[t.table_id] = SchemaTable(t.table_id, dict_list_to_cols(t.columns))

  # Construct a list of columns sorted by table and position.
  collist = sorted(actions.transpose_bulk_action(meta_columns),
                   key=lambda c: (c.parentId, c.parentPos))
  coldict = {t: list(cols) for t, cols in itertools.groupby(collist, lambda r: r.parentId)}

  for t in actions.transpose_bulk_action(meta_tables):
    columns = OrderedDict((c.colId, SchemaColumn(c.colId, c.type, c.isFormula, c.formula))
                          for c in coldict[t.id])
    schema[t.tableId] = SchemaTable(t.tableId, columns)
  return schema
