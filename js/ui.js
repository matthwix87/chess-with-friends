// Small DOM helpers: modal dialogs and toasts.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let modalResolve = null;

/**
 * Show a modal. `buttons` = [{label, value, primary}]. `input` optionally
 * adds a text field ({value, placeholder}); the result is then {value, text}.
 * Resolves with the clicked button's value (or null when dismissed).
 */
export function showModal({ title, text = '', buttons = [{ label: 'OK', value: true, primary: true }], input = null, dismissable = true }) {
  closeModal(null);
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  const p = $('#modalText');
  p.textContent = text;
  p.classList.toggle('hidden', !text);
  const actions = $('#modalActions');
  actions.innerHTML = '';
  let field = null;
  if (input) {
    field = document.createElement('input');
    field.type = 'text';
    field.maxLength = 24;
    field.value = input.value || '';
    field.placeholder = input.placeholder || '';
    field.className = 'modal-input';
    field.style.cssText = 'padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-elev-2);color:var(--text);margin-bottom:6px';
    actions.appendChild(field);
  }
  return new Promise((resolve) => {
    modalResolve = resolve;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = b.primary ? 'btn-primary' : 'btn';
      el.textContent = b.label;
      el.dataset.value = String(b.value);
      el.addEventListener('click', () => closeModal(field ? { value: b.value, text: field.value.trim() } : b.value));
      actions.appendChild(el);
    }
    modal.onclick = (e) => { if (dismissable && e.target === modal) closeModal(null); };
    modal.classList.remove('hidden');
    if (field) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') closeModal({ value: buttons[0].value, text: field.value.trim() }); });
  });
}

export function closeModal(value = null) {
  const modal = $('#modal');
  if (!modal) return;
  modal.classList.add('hidden');
  const r = modalResolve;
  modalResolve = null;
  if (r) r(value);
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
