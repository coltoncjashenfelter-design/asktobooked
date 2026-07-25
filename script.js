(function () {
  var menuToggle = document.querySelector('.menu-toggle');
  var drawer = document.querySelector('.drawer');
  var nav = document.querySelector('.nav');

  // ---------------------------------------------------------------------
  // Mobile navigation.
  // Two patterns exist on this site:
  //   1. Drawer  — consulting, contact, contact-form, 404, legal pages.
  //   2. Inline  — index, guide, about (restructured pages).
  // Pick whichever the current page actually contains.
  // ---------------------------------------------------------------------

  if (menuToggle && drawer) {
    var overlay = document.querySelector('.drawer-overlay');
    var closeBtn = document.querySelector('.drawer-close');

    var isOpen = function () {
      return drawer.classList.contains('is-open');
    };

    var setOpen = function (open) {
      drawer.classList.toggle('is-open', open);
      if (overlay) overlay.classList.toggle('is-open', open);
      document.body.classList.toggle('drawer-open', open);
      menuToggle.setAttribute('aria-expanded', String(open));
      if (open && closeBtn) {
        closeBtn.focus();
      } else if (!open) {
        menuToggle.focus();
      }
    };

    menuToggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });

    if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
    if (overlay) overlay.addEventListener('click', function () { setOpen(false); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });

    drawer.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () { setOpen(false); });
    });
  } else if (menuToggle && nav) {
    menuToggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      menuToggle.setAttribute('aria-expanded', String(open));
    });

    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        nav.classList.remove('is-open');
        menuToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Smooth scroll offset for the sticky header (same-page anchors only).
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var targetId = this.getAttribute('href');
      if (targetId === '#') return;

      var target = document.querySelector(targetId);
      if (!target) return;

      e.preventDefault();
      var headerHeight = 72;
      var top = target.getBoundingClientRect().top + window.scrollY - headerHeight;
      window.scrollTo({ top: top, behavior: 'smooth' });
    });
  });
})();
