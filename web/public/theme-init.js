// Applies the saved color theme before the first paint (no flash).
// Only the theme choice is stored in the browser; no business data is.
(function () {
  var theme = 'system'
  try {
    theme = localStorage.getItem('theme') || 'system'
  } catch (e) {}
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) document.documentElement.classList.add('dark')
})()
