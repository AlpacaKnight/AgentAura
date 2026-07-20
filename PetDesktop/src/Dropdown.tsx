import { useEffect, useRef, useState } from 'react';

export type DropdownOption<T extends string> = {
  value: T;
  label: string;
};

type DropdownProps<T extends string> = {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
};

/**
 * 自定义下拉组件，纯 div 渲染。
 * 替代原生 <select>，避免 Linux WebKitGTK 下弹出列表使用系统 GTK 主题
 * 导致浅色背景与深色 UI 不一致的问题。
 */
export default function Dropdown<T extends string>({ value, options, onChange, placeholder = '请选择' }: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div className={`dropdown${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="dropdown-trigger" onClick={() => setOpen(v => !v)}>
        <span>{selected?.label ?? placeholder}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul className="dropdown-list" role="listbox">
          {options.map(opt => (
            <li key={opt.value} role="option" aria-selected={opt.value === value} className={opt.value === value ? 'selected' : ''} tabIndex={0} onClick={() => { onChange(opt.value); setOpen(false); }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(opt.value); setOpen(false); } }}>
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
