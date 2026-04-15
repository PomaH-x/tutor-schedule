function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast';
  if (type === 'error') toast.classList.add('toast-error');
  if (type === 'success') toast.classList.add('toast-success');
  toast.classList.add('visible');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.remove('visible'), 3000);
}
