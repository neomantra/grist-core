/* global document */
const moment = require('moment-timezone');
const _ = require('underscore');
const dom = require('../lib/dom');
const dispose = require('../lib/dispose');
const kd = require('../lib/koDom');
const DateEditor = require('./DateEditor');
const gutil = require('app/common/gutil');
const { parseDate } = require('app/common/parseDate');

/**
 * DateTimeEditor - Editor for DateTime type. Includes a dropdown datepicker.
 *  See reference: http://bootstrap-datepicker.readthedocs.org/en/latest/index.html
 */
function DateTimeEditor(options) {
  // Get the timezone from the end of the type string.
  options.timezone = gutil.removePrefix(options.field.column().type(), "DateTime:");

  // Adjust the command group.
  var origCommands = options.commands;
  options.commands = Object.assign({}, origCommands, {
    prevField: () => this._focusIndex() === 1 ? this._setFocus(0) : origCommands.prevField(),
    nextField: () => this._focusIndex() === 0 ? this._setFocus(1) : origCommands.nextField(),
  });

  // Call the superclass.
  DateEditor.call(this, options);

  this._timeFormat = options.field.widgetOptionsJson.peek().timeFormat;

  // To reuse code, this knows all about the DOM that DateEditor builds (using TextEditor), and
  // modifies that to be two side-by-side textareas.
  this._dateSizer = this.contentSizer;    // For consistency with _timeSizer and _timeInput.
  this._dateInput = this.textInput;
  dom(this.dom, kd.toggleClass('celleditor_datetime', true));
  dom(this.dom.firstChild, kd.toggleClass('celleditor_datetime_editor', true));
  this.dom.appendChild(
    dom('div.celleditor_cursor_editor.celleditor_datetime_editor',
      this._timeSizer = dom('div.celleditor_content_measure'),
      this._timeInput = dom('textarea.celleditor_text_editor',
        // Use a placeholder of 12:00am, since that is the autofill time value.
        kd.attr('placeholder', moment.tz('0', 'H', this.timezone).format(this._timeFormat)),
        kd.value(this.formatValue(options.cellValue, this._timeFormat)),
        this.commandGroup.attach(),
        dom.on('input', () => this._resizeInput())
      )
    )
  );
}

dispose.makeDisposable(DateTimeEditor);
_.extend(DateTimeEditor.prototype, DateEditor.prototype);

DateTimeEditor.prototype.setSizerLimits = function() {
  var maxSize = this.editorPlacement.calcSize({width: Infinity, height: Infinity}, {calcOnly: true});
  this._dateSizer.style.maxWidth =
    this._timeSizer.style.maxWidth = Math.ceil(maxSize.width / 2 - 6) + 'px';
};

/**
 * Returns which element has focus: 0 if date, 1 if time, null if neither.
 */
DateTimeEditor.prototype._focusIndex = function() {
  return document.activeElement === this._dateInput ? 0 :
    (document.activeElement === this._timeInput ? 1 : null);
};

/**
 * Sets focus to date if index is 0, or time if index is 1.
 */
DateTimeEditor.prototype._setFocus = function(index) {
  var elem = (index === 0 ? this._dateInput : (index === 1 ? this._timeInput : null));
  if (elem) {
    elem.focus();
    elem.selectionStart = 0;
    elem.selectionEnd = elem.value.length;
  }
};

DateTimeEditor.prototype.getCellValue = function() {
  let date = this._dateInput.value;
  let time = this._timeInput.value;
  let timestamp = parseDate(date, {
    dateFormat: this.safeFormat,
    time: time,
    timeFormat: this._timeFormat,
    timezone: this.timezone
  });
  return timestamp !== null ? timestamp :
    (date && time ? `${date} ${time}` : date || time);
};

/**
 * Overrides the resizing function in TextEditor.
 */
DateTimeEditor.prototype._resizeInput = function() {
  // Use the size calculation provided in options.calcSize (that takes into account cell size and
  // screen size), with both date and time parts as the input. The resulting size is applied to
  // the parent (containing date + time), with date and time each expanding or shrinking from the
  // measured sizes using flexbox logic.
  this._dateSizer.textContent = this._dateInput.value;
  this._timeSizer.textContent = this._timeInput.value;
  var dateRect = this._dateSizer.getBoundingClientRect();
  var timeRect = this._timeSizer.getBoundingClientRect();
  // Textboxes get 3px of padding on left/right/top (see TextEditor.css); we specify it manually
  // since editorPlacement can't do a good job figuring it out with the flexbox arrangement.
  var size = this.editorPlacement.calcSize({
    width: dateRect.width + timeRect.width + 12,
    height: Math.max(dateRect.height, timeRect.height) + 3
  });
  this.dom.style.width = size.width + 'px';
  this._dateInput.parentNode.style.flexBasis = (dateRect.width + 6) + 'px';
  this._timeInput.parentNode.style.flexBasis = (timeRect.width + 6) + 'px';
  this._dateInput.style.height = Math.ceil(size.height - 3) + 'px';
  this._timeInput.style.height = Math.ceil(size.height - 3) + 'px';
};

module.exports = DateTimeEditor;
