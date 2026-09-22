/* sim.js — вспомогательные функции и палитра (демонстрационные данные и имитация участников удалены) */
(function () {
  const palette = ['linear-gradient(135deg,#38bdf8,#4c7dff)', 'linear-gradient(135deg,#8b5cf6,#ec4899)', 'linear-gradient(135deg,#38ef7d,#11998e)', 'linear-gradient(135deg,#f59e0b,#ef4444)', 'linear-gradient(135deg,#6366f1,#38bdf8)', 'linear-gradient(135deg,#f472b6,#8b5cf6)', 'linear-gradient(135deg,#14b8a6,#22c55e)', 'linear-gradient(135deg,#fb7185,#f59e0b)'];
  const solid = ['#38bdf8', '#8b5cf6', '#22c55e', '#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#fb7185'];
  const initials = n => (n || '').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();

  window.SIM = {
    initials, palette, solid,
    contacts: [],      // контакты добавляет сам пользователь
    meetings: [],      // расписание заполняется через «Запланировать»
    recordings: [],    // записи появляются после реальной записи встречи
    makeParticipants() { return []; },
  };

  window.genMeetingId = () => `${rnd(100, 999)} ${rnd(1000, 9999)} ${rnd(1000, 9999)}`;
  function rnd(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
  window.rnd = rnd;
})();
