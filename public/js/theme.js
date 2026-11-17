(function () {
  var KEY = 'serverops-theme';
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function preferred() {
    var s = saved();
    if (s === 'dark' || s === 'light') return s;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function updateButton(theme) {
    var btn = document.getElementById('btnThemeToggle');
    if (!btn) return;
    var isDark = theme === 'dark';
    btn.title = isDark ? 'الوضع الفاتح' : 'الوضع الداكن';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(isDark));
    btn.innerHTML = '<i data-feather="' + (isDark ? 'sun' : 'moon') + '"></i>';
    if (window.feather) window.feather.replace();
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', theme);
    updateButton(theme);
  }

  apply(preferred());

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function (e) { if (!saved()) apply(e.matches ? 'dark' : 'light'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('btnThemeToggle');
    if (!btn) return;
    updateButton(root.getAttribute('data-theme'));
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) { }
      apply(next);
    });
  });
})();
