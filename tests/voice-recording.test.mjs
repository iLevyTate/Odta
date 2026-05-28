/**
 * Voice recording + speech input wiring guards.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const attachments = readFileSync(join(root, 'js', 'attachments.js'), 'utf8');

test('task voice recording surfaces errors via showExportToast, not missing toast()', () => {
  assert.doesNotMatch(ui, /typeof toast === 'function'/, 'ui.js must not call undefined toast()');
  assert.match(ui, /function _voiceToast[\s\S]*?showExportToast/, 'voice feedback uses showExportToast');
  assert.match(ui, /Voice note saved/, 'successful recording confirms to the user');
});

test('mobile and iOS recorders prefer whole-blob capture and mp4 mime', () => {
  assert.match(ui, /isApple[\s\S]*?'audio\/mp4'/, 'Apple platforms prefer mp4 for MediaRecorder');
  assert.match(ui, /function _needsWholeBlobRecording/, 'mobile/iOS whole-blob recording helper exists');
  assert.match(ui, /if\(_needsWholeBlobRecording\(\)\) recorder\.start\(\)/, 'mobile uses start() without timeslice');
});

test('quick-add voice input reports permission and support errors', () => {
  assert.match(ui, /function _voiceErrorMessage/, 'speech errors mapped for users');
  assert.match(ui, /openQuickAddSheet[\s\S]*?showVoiceButtonIfSupported/, 'sheet open refreshes mic button');
});

test('attachment limits use showExportToast', () => {
  assert.doesNotMatch(attachments, /typeof toast === 'function'/, 'attachments.js must not call undefined toast()');
  assert.match(attachments, /showExportToast\('Max .* voice notes per task'\)/, 'audio cap toast wired');
});
