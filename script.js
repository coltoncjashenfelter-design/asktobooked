(function () {
  // Drawer navigation
  const menuToggle = document.querySelector('.menu-toggle');
  const drawer = document.querySelector('.drawer');
  const overlay = document.querySelector('.drawer-overlay');
  const closeBtn = document.querySelector('.drawer-close');

  function isOpen() {
    return drawer && drawer.classList.contains('is-open');
  }

  function setOpen(open) {
    if (!drawer) return;
    drawer.classList.toggle('is-open', open);
    if (overlay) overlay.classList.toggle('is-open', open);
    document.body.classList.toggle('drawer-open', open);
    if (menuToggle) menuToggle.setAttribute('aria-expanded', String(open));
    if (open && closeBtn) {
      closeBtn.focus();
    } else if (!open && menuToggle) {
      menuToggle.focus();
    }
  }

  if (menuToggle && drawer) {
    menuToggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
  if (overlay) overlay.addEventListener('click', function () { setOpen(false); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });

  if (drawer) {
    drawer.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        drawer.classList.remove('is-open');
        if (overlay) overlay.classList.remove('is-open');
        document.body.classList.remove('drawer-open');
        if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Smooth scroll offset for sticky header (same-page anchors only)
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;

      const target = document.querySelector(targetId);
      if (!target) return;

      e.preventDefault();
      const headerHeight = 72;
      const top = target.getBoundingClientRect().top + window.scrollY - headerHeight;
      window.scrollTo({ top: top, behavior: 'smooth' });
    });
  });
})();
