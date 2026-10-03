import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TextStyle, Color as TiptapColor, FontFamily, BackgroundColor } from '@tiptap/extension-text-style';
import { TextAlign } from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { useTranslation } from 'react-i18next';
import { resizeImageToDataUrl, RichToolbar } from './ComposeModal.tsx';

const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() { return { types: ['textStyle'] }; },
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        fontSize: {
          default: null,
          parseHTML: element => element.style.fontSize || null,
          renderHTML: attrs => attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
        },
      },
    }];
  },
  addCommands() {
    return {
      setFontSize: size => ({ chain }) => chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize: () => ({ chain }) => chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    };
  },
});

interface Props {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  minHeight?: number;
  testId?: string;
  onAttach?: () => void;
  allowInlineImages?: boolean;
}

/** Shared compose-mail body surface used by normal compose and MCP human approval edits. */
export default function ComposeBodyField({ value, onChange, disabled = false, minHeight = 180, testId = 'compose-body-field', onAttach, allowInlineImages = false }: Props) {
  const { t } = useTranslation();
  const imageInput = useRef<HTMLInputElement | null>(null);
  const [htmlMode, setHtmlMode] = useState(false);
  const [htmlSource, setHtmlSource] = useState(value);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TextStyle,
      TiptapColor,
      FontFamily,
      BackgroundColor,
      FontSize,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ inline: true, allowBase64: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: t('compose.bodyPh') }),
    ],
    content: value,
    immediatelyRender: false,
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
    editorProps: { attributes: { spellcheck: 'true', 'data-testid': `${testId}-editable` } },
  });

  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  useEffect(() => {
    if (!editor || editor.isFocused || htmlMode) return;
    if (editor.getHTML() !== value) editor.commands.setContent(value, { emitUpdate: false });
    setHtmlSource(value);
  }, [editor, htmlMode, value]);

  const toggleHtml = () => {
    if (!editor) return;
    if (!htmlMode) {
      setHtmlSource(editor.getHTML());
      setHtmlMode(true);
      return;
    }
    editor.commands.setContent(htmlSource, { emitUpdate: false });
    onChange(editor.getHTML());
    setHtmlMode(false);
  };

  const insertImage = async (file: File | undefined) => {
    if (!file || !editor || !file.type.startsWith('image/')) return;
    try { const src = await resizeImageToDataUrl(file); editor.chain().focus().setImage({ src }).run(); } catch { /* preserve the authored body on image errors */ }
  };

  return <div className="tiptap-compose" data-testid={testId} aria-disabled={disabled || undefined} style={{ minHeight }}>
    {allowInlineImages && <input ref={imageInput} type="file" accept="image/*" style={{display:'none'}} onChange={event=>{void insertImage(event.target.files?.[0]);event.target.value='';}}/>}
    {editor && !disabled && <RichToolbar editor={editor} onAttach={onAttach} onInsertImage={allowInlineImages ? ()=>imageInput.current?.click() : undefined} htmlMode={htmlMode} onToggleHtml={toggleHtml} />}
    {htmlMode ? <textarea
      value={htmlSource}
      disabled={disabled}
      onChange={event => { setHtmlSource(event.target.value); onChange(event.target.value); }}
      spellCheck={false}
      aria-label={t('signatureEditor.sourceMode')}
      style={{ width: '100%', minHeight, padding: '12px 14px', background: 'var(--bg-secondary)', border: 'none', color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.6, fontFamily: 'monospace', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
    /> : <EditorContent editor={editor}/>}
  </div>;
}
