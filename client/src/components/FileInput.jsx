import { useEffect, useRef, useState } from 'react';
import { Button } from './ui.jsx';
import { cx, formatBytes } from '../utils/format.js';

/**
 * Photograph picker for fault evidence and repair before/after shots.
 *
 * Client-side checks (type, size, count) exist only to save the user a wasted upload; the
 * server re-validates the bytes (magic bytes, per-kind policy, limits) — see
 * server/src/lib/files.js.  `capture="environment"` is what makes a phone open the camera
 * directly, which is the whole point on a lab bench.
 */
export function FileInput({
  label = 'Photographs', accept = 'image/*', multiple = true, maxFiles = 5, maxSizeMb = 8,
  onChange, value = [], hint, capture, error, disabled, kind = 'photo',
}) {
  const inputRef = useRef(null);
  const [localError, setLocalError] = useState(null);
  const files = value ?? [];

  const validate = (list) => {
    const problems = [];
    const next = [...files];
    const allowedExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf', '.txt', '.csv', '.docx'];
    for (const file of list) {
      const ext = `.${(file.name.split('.').pop() ?? '').toLowerCase()}`;
      if (kind === 'photo' && !file.type.startsWith('image/')) problems.push(`“${file.name}” is not a photo.`);
      if (!allowedExt.includes(ext)) problems.push(`“${file.name}” has an unsupported type (${ext}).`);
      if (file.size > maxSizeMb * 1024 * 1024) problems.push(`“${file.name}” is larger than ${maxSizeMb} MB.`);
      if (file.size === 0) problems.push(`“${file.name}” is empty.`);
      if (next.length >= maxFiles) { problems.push(`Only ${maxFiles} files can be attached to one report.`); break; }
      next.push(file);
    }
    return { next, problems };
  };

  const add = (fileList) => {
    setLocalError(null);
    const { next, problems } = validate(Array.from(fileList ?? []));
    if (problems.length) setLocalError(problems.join(' '));
    if (next.length !== files.length) onChange?.(next);
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeAt = (index) => {
    const next = files.filter((_, i) => i !== index);
    onChange?.(next);
  };

  // Object URLs are revoked whenever the selection changes or the component unmounts;
  // leaking them is how a long-lived form eventually eats the tab's memory.
  const [urls, setUrls] = useState([]);
  useEffect(() => {
    const created = files.filter((f) => f.type.startsWith('image/')).map((f) => URL.createObjectURL(f));
    setUrls(created);
    return () => created.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  let cursor = -1;
  const previews = files.map((f, i) => {
    const isImage = f.type.startsWith('image/');
    if (isImage) cursor += 1;
    return { file: f, i, url: isImage ? urls[cursor] : null };
  });

  return (
    <div className={cx('fileinput', error && 'fileinput--error')}>
      <div className="fileinput__head">
        <p className="fileinput__label">{label}</p>
        <p className="fileinput__hint">{hint ?? `Up to ${maxFiles} files · max ${maxSizeMb} MB each · photos and PDFs`}</p>
      </div>

      <div className="fileinput__actions">
        <label className="btn btn--secondary">
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            multiple={multiple}
            disabled={disabled || files.length >= maxFiles}
            className="sr-only"
            {...(capture ? { capture } : {})}
            onChange={(e) => add(e.target.files)}
          />
          <span aria-hidden="true">📷</span> Add {kind === 'photo' ? 'photo' : 'file'}
        </label>
        {files.length ? <span className="fileinput__count">{files.length}/{maxFiles} attached</span> : null}
      </div>

      {previews.length ? (
        <ul className="fileinput__list">
          {previews.map(({ file, i, url }) => (
            <li key={`${file.name}-${i}`} className="thumb">
              {url ? <img src={url} alt={`Selected: ${file.name}`} className="thumb__img" /> : <span className="thumb__doc" aria-hidden="true">{(file.name.split('.').pop() ?? 'file').toUpperCase()}</span>}
              <span className="thumb__meta">
                <span className="thumb__name" title={file.name}>{file.name}</span>
                <span className="thumb__size">{formatBytes(file.size)}</span>
              </span>
              <Button size="sm" tone="ghost" onClick={() => removeAt(i)} aria-label={`Remove ${file.name}`}>✕</Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fileinput__empty">No files chosen yet. A photo of the fault helps the technician enormously.</p>
      )}

      {localError || error ? <p className="form-error" role="alert">{localError || error}</p> : null}
    </div>
  );
}
