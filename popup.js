// popup.js - Handles interactive behavior for the popup demo

document.querySelectorAll('.overlay').forEach((overlay) => {
  const button = overlay.querySelector('.overlay__action');
  if (!button) return;
  button.addEventListener('click', () => {
    const collapsed = overlay.classList.toggle('is-collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
  });
});

document.querySelectorAll('.matches').forEach((section) => {
  const cards = section.querySelectorAll('.match-card');
  const buttons = section.querySelectorAll('.carousel-btn');
  const indicators = section.querySelectorAll('.match-indicator');
  if (!buttons.length || cards.length <= 1) return;

  const applyPieData = (card) => {
    const pieWrapper = card.querySelector('.match-score');
    const pie = pieWrapper?.querySelector('.pie');
    const pieValue = pie?.querySelector('.pie-value');
    if (!pieWrapper || !pie) return;
    const score = Number(card.dataset.score || 0);
    const angle = Math.round((score / 100) * 360);
    pie.style.setProperty('--pie-angle', `${angle}deg`);
    if (pieValue) pieValue.textContent = `${score}%`;
    pieWrapper.setAttribute('aria-label', `${score}% match`);
  };

  cards.forEach(applyPieData);

  let index = 0;

  const updateIndicator = () => {
    indicators.forEach((indicator) => {
      indicator.textContent = `${index + 1} of ${cards.length}`;
    });
  };

  const updateUI = () => {
    updateIndicator();
  };

  updateUI();

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      cards[index].classList.remove('is-active');
      index = (index + 1) % cards.length;
      cards[index].classList.add('is-active');
      updateUI();
    });
  });
});
