(() => {
  'use strict';

  const distribution = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/';
  const build = distribution + 'legacy/build/';
  let library;
  let active;

  function clear() {
    if (!active) return;
    const view = active;
    active = null;
    view.observer?.disconnect();
    for (const task of view.renders) task.cancel();
    void view.loadingTask?.destroy().catch(() => {});
    view.container.remove();
  }

  function loadLibrary() {
    library ??= import(build + 'pdf.min.mjs').then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = build + 'pdf.worker.min.mjs';
      return pdfjs;
    }).catch(error => {
      library = undefined;
      throw error;
    });
    return library;
  }

  async function drawPage(view, page, canvas) {
    if (view !== active) return;
    const normal = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, 1600 / normal.width) });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    view.renders.add(task);
    try {
      await task.promise;
      canvas.dataset.rendered = 'true';
    } finally {
      view.renders.delete(task);
    }
  }

  async function loadPages(view, url) {
    const pdfjs = await loadLibrary();
    if (view !== active) return;
    view.loadingTask = pdfjs.getDocument({
      url,
      isEvalSupported: false,
      cMapUrl: distribution + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: distribution + 'standard_fonts/',
      wasmUrl: distribution + 'wasm/'
    });
    const pdf = await view.loadingTask.promise;
    if (view !== active) return;
    view.status.textContent = '原版 PDF · 共 ' + pdf.numPages + ' 页';
    view.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        view.observer.unobserve(entry.target);
        const page = view.pages.get(entry.target);
        void drawPage(view, page, entry.target).catch(() => {
          if (view === active) view.status.textContent = '有页面无法显示，可在新标签页打开原件。';
        });
      }
    }, { rootMargin: '400px 0px' });
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      if (view !== active) return;
      const viewport = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.className = 'course-note-pdf-page';
      canvas.style.aspectRatio = viewport.width + ' / ' + viewport.height;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', '原版 PDF 第 ' + number + ' 页');
      view.pages.set(canvas, page);
      view.container.append(canvas);
      view.observer.observe(canvas);
    }
  }

  function mount(preview, url, title) {
    clear();
    const container = document.createElement('section');
    container.className = 'course-note-pdf';
    container.setAttribute('aria-label', title + ' 原版 PDF');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = '正在加载原版 PDF…';
    container.append(status);
    preview.append(container);
    const view = { container, status, pages: new WeakMap(), renders: new Set() };
    active = view;
    void loadPages(view, url).catch(() => {
      if (view === active) status.textContent = '原版 PDF 暂时无法加载，可在新标签页打开原件。';
    });
  }

  window.CoursePdfReader = { mount, clear };
})();
