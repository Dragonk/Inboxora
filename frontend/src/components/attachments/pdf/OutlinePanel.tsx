import { Button } from '../../ui.tsx';
export interface OutlineItem { title: string; dest: string | unknown[] | null; children: OutlineItem[] }
export function outlineItems(value: unknown, depth = 0): OutlineItem[] {
  if (!Array.isArray(value) || depth > 12) return [];
  return value.slice(0, 1000).map(item => {
    if (!item || typeof item !== 'object') return { title: '', dest: null, children: [] };
    return { title: typeof item.title === 'string' ? item.title : '', dest: typeof item.dest === 'string' || Array.isArray(item.dest) ? item.dest : null, children: outlineItems(item.items, depth + 1) };
  });
}
export default function OutlinePanel({ items, navigate }: { items: OutlineItem[]; navigate: (destination: OutlineItem['dest']) => void }) {
  return <ul className="attachment-outline">{items.map((item, index) => <li key={index}>
    {item.children.length ? <details><summary>{item.title}</summary><Button onClick={() => navigate(item.dest)}>{item.title}</Button><OutlinePanel items={item.children} navigate={navigate} /></details>
      : <Button onClick={() => navigate(item.dest)}>{item.title}</Button>}
  </li>)}</ul>;
}
