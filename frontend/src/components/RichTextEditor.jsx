import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TextAlign } from '@tiptap/extension-text-align';
import { richTextEditorContent } from '../utils/richText.js';

// One shared WYSIWYG surface for short rich-text fields (calendar descriptions).
// It is deliberately the same Tiptap stack the compose window uses, so the value
// it produces is the same kind of HTML a message body carries — which is what
// lets the reader render it through the mail body renderer.
const BUTTON = { background: 'none', border: 'none', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', padding: '3px 7px', fontSize: 12, lineHeight: 1.4, minWidth: 26 };

function ToolButton({ label, active, onActivate, testId, children }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={Boolean(active)} data-testid={testId}
    onMouseDown={event => { event.preventDefault(); onActivate(); }}
    style={{ ...BUTTON, background: active ? 'var(--bg-hover)' : 'none', color: active ? 'var(--accent)' : 'var(--text-secondary)' }}
  >{children}</button>;
}

export default function RichTextEditor({ value = '', onChange, placeholder = '', label = '', testId = 'rich-text-editor', minHeight = 120 }) {
  const { t } = useTranslation();
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder }),
    ],
    content: richTextEditorContent(value),
    immediatelyRender: false,
    onUpdate: ({ editor: instance }) => onChange?.(instance.getHTML()),
    editorProps: { attributes: { 'aria-label': label || placeholder || '' } },
  });

  // The form owns the value, and it is replaced from outside when an event is
  // opened for editing or a failed save restores the draft. Only then is the
  // document replaced — never while the user is typing in it.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const next = richTextEditorContent(value);
    if (editor.getHTML() !== next) editor.commands.setContent(next, false);
  }, [editor, value]);

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => instance ? {
      bold: instance.isActive('bold'),
      italic: instance.isActive('italic'),
      underline: instance.isActive('underline'),
      strike: instance.isActive('strike'),
      bulletList: instance.isActive('bulletList'),
      orderedList: instance.isActive('orderedList'),
      link: instance.isActive('link'),
    } : {},
  });
  const active = state || {};

  const insertLink = () => {
    if (!editor) return;
    const url = window.prompt(t('signatureEditor.linkPrompt'), editor.getAttributes('link')?.href || '');
    if (url === null) return;
    if (!url) { editor.chain().focus().unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` }).run();
  };

  return <div className="rich-text-editor" data-testid={testId} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-primary)', overflow: 'hidden' }}>
    <div role="toolbar" aria-label={label || placeholder} data-testid={`${testId}-toolbar`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, padding: 3, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>
      <ToolButton label={t('signatureEditor.bold')} active={active.bold} testId={`${testId}-bold`} onActivate={() => { editor?.chain().focus().toggleBold().run(); }}><b>B</b></ToolButton>
      <ToolButton label={t('signatureEditor.italic')} active={active.italic} testId={`${testId}-italic`} onActivate={() => { editor?.chain().focus().toggleItalic().run(); }}><i>I</i></ToolButton>
      <ToolButton label={t('signatureEditor.underline')} active={active.underline} testId={`${testId}-underline`} onActivate={() => { editor?.chain().focus().toggleUnderline().run(); }}><u>U</u></ToolButton>
      <ToolButton label={t('signatureEditor.strikethrough')} active={active.strike} testId={`${testId}-strike`} onActivate={() => { editor?.chain().focus().toggleStrike().run(); }}><s>S</s></ToolButton>
      <ToolButton label={t('richTextEditor.bulletList')} active={active.bulletList} testId={`${testId}-bullet-list`} onActivate={() => { editor?.chain().focus().toggleBulletList().run(); }}>•</ToolButton>
      <ToolButton label={t('richTextEditor.orderedList')} active={active.orderedList} testId={`${testId}-ordered-list`} onActivate={() => { editor?.chain().focus().toggleOrderedList().run(); }}>1.</ToolButton>
      <ToolButton label={t('signatureEditor.link')} active={active.link} testId={`${testId}-link`} onActivate={insertLink}>🔗</ToolButton>
      <ToolButton label={t('richTextEditor.clearFormat')} testId={`${testId}-clear`} onActivate={() => { editor?.chain().focus().unsetAllMarks().clearNodes().run(); }}>⌫</ToolButton>
    </div>
    <div className="rich-text-editor-content" style={{ minHeight, maxHeight: 320, overflowY: 'auto', padding: '8px 10px', fontSize: 13 }}>
      <EditorContent editor={editor} />
    </div>
  </div>;
}
