const state = {
  user: null,
  profile: null,
  currentWeekStart: null,
  lessons: [],
  students: [],
  selectedRole: null,
  lessonModal: null,
  placingLesson: null,
  placingStudent: null
};

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function formatDateShort(date) {
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
