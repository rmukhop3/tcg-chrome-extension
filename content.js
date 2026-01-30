console.log('Triangulator extension loaded');

// Function to extract course data from HTML
function extractCourseData(element) {
  // Look for the course data structure in the real TCG
  const row = element.closest('tr');
  if (!row) return null;

  const courseData = {
    institution: null,
    subject: null,
    number: null,
    title: null,
    hours: null,
    sourceId: null,
    requestId: null
  };

  // Extract institution
  const institutionLink = row.querySelector('.institutionText a');
  if (institutionLink) {
    courseData.institution = institutionLink.textContent.trim();
    const href = institutionLink.getAttribute('href');
    const sourceIdMatch = href?.match(/sourceId=([A-Z0-9]+)/);
    if (sourceIdMatch) {
      courseData.sourceId = sourceIdMatch[1];
    }
  }

  // Get request ID from any span with class pattern like "subject_1802784"
  const subjectSpan = row.querySelector('[class*="subject_"]');
  if (subjectSpan) {
    courseData.subject = subjectSpan.textContent.trim();
    // Extract request ID from class name
    const classMatch = subjectSpan.className.match(/subject_(\d+)/);
    if (classMatch) {
      courseData.requestId = classMatch[1];
    }
  }

  // Extract course number
  const numberSpan = row.querySelector('[class*="number_"]');
  if (numberSpan) {
    courseData.number = numberSpan.textContent.trim();
  }

  // Extract title
  const titleSpan = row.querySelector('[class*="title_"]');
  if (titleSpan) {
    courseData.title = titleSpan.textContent.trim();
  }

  // Extract hours
  const hoursSpan = row.querySelector('[class*="hours_"]');
  if (hoursSpan) {
    courseData.hours = hoursSpan.textContent.trim();
  }

  // Check if we have at least the basic course info
  if (courseData.subject && courseData.number) {
    return courseData;
  }

  return null;
}

// Function to show the Triangulator popup
function showTriangulatorPopup(courseData, event) {
  // Remove any existing popup
  const existingPopup = document.getElementById('triangulator-popup');
  if (existingPopup) {
    existingPopup.remove();
  }

  // Create popup container
  const popup = document.createElement('div');
  popup.id = 'triangulator-popup';
  popup.className = 'triangulator-popup';

  // Position the popup in top-right corner using right positioning for smooth animations
  popup.style.position = 'fixed';
  popup.style.right = '0';
  popup.style.top = '0';
  popup.style.transform = 'none';
  popup.style.zIndex = '2147483647'; // Maximum z-index to stay on top

  // Show loading state immediately
  popup.innerHTML = generatePopupHTML(courseData, { loading: true });
  document.body.appendChild(popup);
  initializePopupControls(popup);

  // Send message to background script to fetch all course data (unified)
  chrome.runtime.sendMessage({
    action: 'getCourseData',
    courseData: courseData
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Runtime error:', chrome.runtime.lastError);
      popup.innerHTML = generatePopupHTML(courseData, { loading: false, error: 'Connection error' });
      initializePopupControls(popup);
      return;
    }

    console.log('Received data from background:', response);

    if (response && response.success) {
      // Show popup with data
      popup.innerHTML = generatePopupHTML(courseData, {
        description: response.description,
        matches: response.matches,
        match_type: response.match_type,
        similarity: response.similarity,
        reflected_course: response.reflected_course,
        description_is_missing: response.description_is_missing,
        loading: false
      });
      initializePopupControls(popup);

      // Initialize carousel if there are matches
      const container = popup.querySelector('#matches-container');
      const matchesSection = container?.querySelector('.matches');
      if (matchesSection) {
        initializeMatchCarousel(matchesSection);
      }
    } else {
      popup.innerHTML = generatePopupHTML(courseData, {
        loading: false,
        error: response?.error || 'Failed to fetch course details'
      });
      initializePopupControls(popup);
    }
  });
}

// Function to generate popup HTML
function generatePopupHTML(courseData, response) {
  const hasMatches = response && response.matches && response.matches.length > 0;
  const isLoading = response && response.loading;
  const isError = response && response.error;
  const courseDescription = response?.description || 'Course data is currently unavailable for this listing.';
  const matchType = response?.match_type || 'none';
  const reflectedCourse = response?.reflected_course;
  const descriptionMissing = response?.description_is_missing;

  const getStatusIndicatorHTML = (type) => {
    let icon = '';
    let label = '';
    let className = '';

    switch (type) {
      case 'exact':
        icon = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
        label = 'Suggested Matches';
        className = 'match-status--exact';
        break;
      case 'strong_fuzzy':
      case 'fuzzy':
        icon = '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
        label = 'Fuzzy Match';
        className = 'match-status--fuzzy';
        break;
      case 'no_match':
        icon = '<svg viewBox="0 0 24 24"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>';
        label = 'Course Not Found';
        className = 'match-status--none';
        break;
      case 'catalog_not_found':
        icon = '<svg viewBox="0 0 24 24"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>';
        label = 'Catalog Not Found';
        className = 'match-status--none';
        break;
      default:
        return '';
    }

    return `
      <div class="match-status ${className}">
        ${icon}
        <span class="match-status-label">${label}</span>
      </div>
    `;
  };

  const isFuzzy = (matchType === 'fuzzy' || matchType === 'strong_fuzzy');
  const isMatch = (matchType === 'exact' || isFuzzy);

  return `
    <section class="overlay" role="dialog" aria-labelledby="course-title">
      <button class="overlay__action" type="button" aria-label="Toggle course details" aria-expanded="true"></button>
      <div class="overlay__content">
        <header>
          <p class="institution">${courseData.institution || 'Institution'}</p>
          <h1 id="course-title">
            ${courseData.title || 'Course Title'}
            <span class="course-meta">${courseData.subject} ${courseData.number} • ${courseData.hours} credit hours</span>
          </h1>

          ${!isLoading && !isError && matchType !== 'exact' ? getStatusIndicatorHTML(matchType) : ''}

          ${!isLoading && !isError && isFuzzy && reflectedCourse && reflectedCourse.subject ? `
            <div class="reflected-header" style="margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--divider);">
              <h1 class="reflected-title">
                ${reflectedCourse.title || 'Catalog Match'}
                <span class="course-meta">${reflectedCourse.subject} ${reflectedCourse.number}</span>
              </h1>
            </div>
          ` : ''}
        </header>

        ${!isLoading && !isError && isMatch ? `
        <section class="description" aria-label="Course description">
          <p class="section-label">Course Description</p>
          <p>
            ${descriptionMissing ? `<span style="color: #666; font-style: italic; display: block; margin-bottom: 8px;">(Subject/Number matched, but full catalog description is missing)</span>` : ''}
            ${courseDescription}
          </p>
        </section>
        ` : isLoading ? `
        <section class="description" aria-label="Course description">
          <p class="section-label">Course Description</p>
          <p>Loading description...</p>
        </section>
        ` : ''}

        ${!isLoading && !isError && isMatch ? `
        <div id="matches-container">
          ${matchType === 'exact' ? getStatusIndicatorHTML(matchType) : ''}
          ${isLoading ? '<section class="matches"><p style="text-align: center; color: #666; padding: 20px;">Finding matches...</p></section>' : ''}
          ${isError ? `<section class="matches"><p style="text-align: center; color: #d32f2f; padding: 20px;">${response.error}</p></section>` : ''}
          ${hasMatches ? generateMatchesHTML(response.matches) : '<section class="matches"><p style="text-align: center; color: #666; padding: 20px; font-style: italic;">No equivalent courses found at ASU.</p></section>'}
        </div>
        ` : isLoading ? `
        <div id="matches-container">
          <section class="matches"><p style="text-align: center; color: #666; padding: 20px;">Finding matches...</p></section>
        </div>
        ` : isError ? `
        <div id="matches-container">
          <section class="matches"><p style="text-align: center; color: #d32f2f; padding: 20px;">${response.error}</p></section>
        </div>
        ` : ''}
      </div>
    </section>
  `;
}

// Function to update popup with matches after they load
function updatePopupWithMatches(popup, matches) {
  const container = popup.querySelector('#matches-container');
  if (!container) return;

  if (matches && matches.length > 0) {
    container.innerHTML = generateMatchesHTML(matches);
    // Re-initialize carousel controls for the matches
    const matchesSection = container.querySelector('.matches');
    if (matchesSection) {
      initializeMatchCarousel(matchesSection);
    }
  } else {
    container.innerHTML = '<section class="matches"><p style="text-align: center; color: #666; padding: 20px;">No matches found.</p></section>';
  }
}

// Initialize carousel for a specific matches section
function initializeMatchCarousel(section) {
  const cards = section.querySelectorAll('.match-card');
  const buttons = section.querySelectorAll('.carousel-btn');
  const indicators = section.querySelectorAll('.match-indicator');

  if (!buttons.length || cards.length <= 1) return;

  // Apply pie chart data
  cards.forEach(card => {
    const pieWrapper = card.querySelector('.match-score');
    const pie = pieWrapper?.querySelector('.pie');
    const pieValue = pie?.querySelector('.pie-value');
    if (!pieWrapper || !pie) return;
    const score = Number(card.dataset.score || 0);
    const angle = Math.round((score / 100) * 360);
    pie.style.setProperty('--pie-angle', `${angle}deg`);
    if (pieValue) pieValue.textContent = `${score}%`;
    pieWrapper.setAttribute('aria-label', `${score}% match`);
  });

  let index = 0;

  const updateIndicator = () => {
    indicators.forEach((indicator) => {
      indicator.textContent = `${index + 1} of ${cards.length}`;
    });
  };

  updateIndicator();

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      cards[index].classList.remove('is-active');
      if (button.classList.contains('carousel-btn--prev')) {
        index = (index - 1 + cards.length) % cards.length;
      } else {
        index = (index + 1) % cards.length;
      }
      cards[index].classList.add('is-active');
      updateIndicator();
    });
  });
}

// Function to generate matches HTML
function generateMatchesHTML(matches) {
  if (!matches || matches.length === 0) return '';

  const matchCards = matches.map((match, index) => `
    <article class="match-card ${index === 0 ? 'is-active' : ''}" data-index="${index}">
      <div class="match-heading">
        <h3>${match.title}</h3>
      </div>
      <span class="match-meta">ASU Match: ${match.subject} ${match.number}</span>
      <p>${match.description}</p>
      <div class="match-controls">
        ${matches.length > 1 ? '<button class="carousel-btn carousel-btn--prev" type="button" aria-label="Show previous match">←</button>' : ''}
        <span class="match-indicator">1 of ${matches.length}</span>
        ${matches.length > 1 ? '<button class="carousel-btn carousel-btn--next" type="button" aria-label="Show next match">→</button>' : ''}
      </div>
    </article>
  `).join('');

  return `
    <section class="matches" aria-label="Equivalent courses at ASU">
      <div class="match-carousel">
        ${matchCards}
      </div>
    </section>
  `;
}

// Function to initialize popup controls
function initializePopupControls(popup) {
  // Prevent ALL clicks on popup from bubbling (except the toggle button)
  const overlay = popup.querySelector('.overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      // Only allow toggle button clicks through
      if (!e.target.closest('.overlay__action')) {
        e.stopPropagation();
      }
    });
  }

  // Toggle button
  const toggleBtn = popup.querySelector('.overlay__action');

  if (toggleBtn) {
    // Dragging variables
    let isDragging = false;
    let dragTimeout = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    toggleBtn.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      const rect = popup.getBoundingClientRect();
      startTop = rect.top;
      startLeft = rect.left;

      dragTimeout = setTimeout(() => {
        isDragging = true;
        popup.style.transition = 'none';
        // Switch from right positioning to left positioning for free movement
        popup.style.right = 'auto';
        popup.style.left = `${startLeft}px`;
        e.preventDefault();
      }, 150);
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      
      const newLeft = startLeft + deltaX;
      const newTop = startTop + deltaY;
      
      const maxLeft = window.innerWidth - popup.offsetWidth;
      const maxTop = window.innerHeight - popup.offsetHeight;
      
      const clampedLeft = Math.max(0, Math.min(newLeft, maxLeft));
      const clampedTop = Math.max(0, Math.min(newTop, maxTop));
      
      popup.style.left = `${clampedLeft}px`;
      popup.style.top = `${clampedTop}px`;
      popup.style.transform = 'none';
      popup.classList.add('is-floating');
    });

    document.addEventListener('mouseup', (e) => {
      clearTimeout(dragTimeout);
      if (isDragging) {
        isDragging = false;
        popup.style.transition = '';
        
        // Check if docked to right edge after drag ends
        const rect = popup.getBoundingClientRect();
        const isAtRightEdge = (rect.right >= window.innerWidth - 10);
        if (isAtRightEdge) {
          popup.classList.remove('is-floating');
          popup.style.left = 'auto';
          popup.style.right = '0';
        }
      } else if (e.target === toggleBtn || toggleBtn.contains(e.target)) {
        // ONLY toggle if the actual button was clicked
        const collapsed = overlay.classList.toggle('is-collapsed');
        toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      }
    });
  }

  // Carousel controls
  const matchesSection = popup.querySelector('.matches');
  if (matchesSection) {
    const cards = matchesSection.querySelectorAll('.match-card');
    const buttons = matchesSection.querySelectorAll('.carousel-btn');
    const indicators = matchesSection.querySelectorAll('.match-indicator');

    if (buttons.length && cards.length > 1) {
      let index = 0;

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

      const updateIndicator = () => {
        indicators.forEach((indicator) => {
          indicator.textContent = `${index + 1} of ${cards.length}`;
        });
      };

      buttons.forEach((button) => {
        button.addEventListener('click', () => {
          cards[index].classList.remove('is-active');
          if (button.classList.contains('carousel-btn--prev')) {
            index = (index - 1 + cards.length) % cards.length;
          } else {
            index = (index + 1) % cards.length;
          }
          cards[index].classList.add('is-active');
          updateIndicator();
        });
      });
    }
  }

  // Add ESC key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      popup.remove();
    }
  });
}

// Listen for clicks on the page
document.addEventListener('click', (event) => {
  const target = event.target;

  // IGNORE if click is inside popup
  if (target.closest('.triangulator-popup')) {
    return;
  }

  // Check if click is within a course row
  const courseData = extractCourseData(target);

  if (courseData) {
    console.log('Course clicked:', courseData);
    showTriangulatorPopup(courseData, event);
  }
});

// Listen for messages from the popup or background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ status: 'active' });
  }
  return true;
});