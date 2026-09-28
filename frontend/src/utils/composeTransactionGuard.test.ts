import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { createComposeTransactionGuard } from './composeTransactionGuard.ts';

test('frozen editor rejects toolbar marks, replacement text and late image-like inserts but permits selection', () => {
  const schema = new Schema({ nodes: { doc: { content: 'text*' }, text: {} }, marks: { bold: {} } });
  let locked = false;
  let state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('original')]), plugins: [createComposeTransactionGuard(() => locked)] });
  state = state.apply(state.tr.insertText('!', 8));
  assert.equal(state.doc.textContent, 'original!');
  locked = true;
  assert.equal(state.applyTransaction(state.tr.addMark(0, 8, schema.mark('bold'))).transactions.length, 0);
  assert.equal(state.applyTransaction(state.tr.insertText('replacement', 0, 9)).transactions.length, 0);
  assert.equal(state.applyTransaction(state.tr.insert(9, schema.text('late callback'))).transactions.length, 0);
  const selected = state.applyTransaction(state.tr.setSelection(TextSelection.create(state.doc, 0, 8)));
  assert.equal(selected.transactions.length, 1);
  assert.equal(selected.state.doc.textContent, 'original!');
  locked = false;
  assert.equal(state.applyTransaction(state.tr.addMark(0, 8, schema.mark('bold'))).transactions.length, 1);
});
