import DOMPurify from 'dompurify';

export default function MessageBodyRenderer({ html = '', text = '', remoteImages = false }) {
  if (!html) return <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;
  const sanitized = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
    FORBID_ATTR: remoteImages ? [] : ['src'],
  });
  return <div dangerouslySetInnerHTML={{ __html: sanitized }} />;
}
