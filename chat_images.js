/* chat_images.js — фото в чате встречи показываются превью, а не файлом (баг #38 от Лаврика).
   Работает поверх meeting.js: следит за панелью чата, находит вложения-картинки (data:image/… или blob:)
   и добавляет миниатюру; клик по миниатюре открывает полноэкранный просмотр с кнопкой «Скачать».
   Ссылка «скачать» под картинкой сохраняется. */
(function () {
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;
  const css = `
.chat-img-wrap { display:block; margin:6px 0 4px; max-width:260px; border-radius:12px; overflow:hidden; cursor:zoom-in; background:rgba(15,23,42,.5); border:1px solid rgba(148,163,184,.25); }
.chat-img-wrap img { display:block; width:100%; height:auto; max-height:240px; object-fit:cover; }
.chat-img-wrap:hover { border-color:#8b5cf6; }
.chat-msg .text a.file.is-image { font-size:12px; opacity:.75; }
.chat-lightbox { position:fixed; inset:0; z-index:9999; background:rgba(2,6,23,.92); display:flex; align-items:center; justify-content:center; flex-direction:column; gap:14px; cursor:zoom-out; animation:fmfade .15s ease-out; }
@keyframes fmfade { from { opacity:0 } to { opacity:1 } }
.chat-lightbox img { max-width:94vw; max-height:84vh; border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,.6); cursor:default; }
.chat-lightbox .lb-bar { display:flex; gap:10px; align-items:center; color:#e2e8f0; font-size:13px; cursor:default; }
.chat-lightbox .lb-bar a, .chat-lightbox .lb-bar button { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:10px; background:rgba(255,255,255,.1); color:#fff; font:inherit; font-weight:700; border:1px solid rgba(255,255,255,.15); cursor:pointer; text-decoration:none; }
.chat-lightbox .lb-bar a:hover, .chat-lightbox .lb-bar button:hover { background:rgba(139,92,246,.5); }
.chat-lightbox .lb-name { max-width:50vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.8; }
`;
  const st = document.createElement('style'); st.id = 'chatImagesCss'; st.textContent = css; document.head.appendChild(st);

  const isImageLink = a => {
    const href = a.getAttribute('href') || '';
    const name = a.getAttribute('download') || a.textContent || '';
    if (/^data:image\//i.test(href)) return true;
    if (/^blob:/i.test(href) && IMG_RE.test(name)) return true;
    return false;
  };

  function openLightbox(src, name) {
    const lb = document.createElement('div'); lb.className = 'chat-lightbox';
    lb.innerHTML = `<img alt=""><div class="lb-bar"><span class="lb-name"></span><a class="lb-dl" download>⬇ Скачать</a><button type="button" class="lb-close">✕ Закрыть</button></div>`;
    const img = lb.querySelector('img'); img.src = src;
    lb.querySelector('.lb-name').textContent = name || 'Изображение';
    const dl = lb.querySelector('.lb-dl'); dl.href = src; dl.download = name || 'image.png';
    const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    lb.addEventListener('click', e => { if (e.target === lb || e.target.closest('.lb-close')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(lb);
  }

  function enhance(root) {
    const scope = root || document;
    scope.querySelectorAll('.chat-msg a[href]').forEach(a => {
      if (a.dataset.imgDone) return;
      if (!isImageLink(a)) return;
      a.dataset.imgDone = '1'; a.classList.add('is-image');
      const src = a.getAttribute('href');
      const name = a.getAttribute('download') || (a.textContent || '').trim();
      const wrap = document.createElement('a'); wrap.className = 'chat-img-wrap'; wrap.href = src; wrap.title = 'Открыть изображение';
      const img = document.createElement('img'); img.alt = name || 'Изображение'; img.loading = 'lazy'; img.src = src;
      img.onerror = () => { wrap.remove(); a.classList.remove('is-image'); };
      wrap.appendChild(img);
      wrap.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openLightbox(src, name); });
      const holder = a.closest('.text') || a.parentElement;
      holder.insertBefore(wrap, holder.firstChild);
      const list = a.closest('.chat-list, .chat-messages, .panel-body');
      if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 200) img.onload = () => { list.scrollTop = list.scrollHeight; };
    });
  }

  let raf = 0;
  const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; enhance(); }); };
  const start = () => {
    const target = document.getElementById('meetingLayer') || document.body;
    new MutationObserver(schedule).observe(target, { childList: true, subtree: true });
    enhance();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.ChatImages = { enhance, openLightbox };
})();
