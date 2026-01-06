// // content.js - Detects clicks on course rows in TCG interface

// console.log('Triangulator extension loaded');

// // Function to extract course data from HTML
// function extractCourseData(element) {
//   // Look for the course data structure in the real TCG
//   const row = element.closest('tr');
//   if (!row) return null;

//   const courseData = {
//     institution: null,
//     subject: null,
//     number: null,
//     title: null,
//     hours: null,
//     sourceId: null,
//     requestId: null
//   };

//   // Extract institution
//   const institutionLink = row.querySelector('.institutionText a');
//   if (institutionLink) {
//     courseData.institution = institutionLink.textContent.trim();
//     const href = institutionLink.getAttribute('href');
//     const sourceIdMatch = href?.match(/sourceId=([A-Z0-9]+)/);
//     if (sourceIdMatch) {
//       courseData.sourceId = sourceIdMatch[1];
//     }
//   }

//   // Get request ID from any span with class pattern like "subject_1802784"
//   const subjectSpan = row.querySelector('[class*="subject_"]');
//   if (subjectSpan) {
//     courseData.subject = subjectSpan.textContent.trim();
//     // Extract request ID from class name
//     const classMatch = subjectSpan.className.match(/subject_(\d+)/);
//     if (classMatch) {
//       courseData.requestId = classMatch[1];
//     }
//   }

//   // Extract course number
//   const numberSpan = row.querySelector('[class*="number_"]');
//   if (numberSpan) {
//     courseData.number = numberSpan.textContent.trim();
//   }

//   // Extract title
//   const titleSpan = row.querySelector('[class*="title_"]');
//   if (titleSpan) {
//     courseData.title = titleSpan.textContent.trim();
//   }

//   // Extract hours
//   const hoursSpan = row.querySelector('[class*="hours_"]');
//   if (hoursSpan) {
//     courseData.hours = hoursSpan.textContent.trim();
//   }

//   // Check if we have at least the basic course info
//   if (courseData.subject && courseData.number) {
//     return courseData;
//   }

//   return null;
// }

// // Function to show the Triangulator popup
// function showTriangulatorPopup(courseData, event) {
//   // Remove any existing popup
//   const existingPopup = document.getElementById('triangulator-popup');
//   if (existingPopup) {
//     existingPopup.remove();
//   }

//   // Create popup container
//   const popup = document.createElement('div');
//   popup.id = 'triangulator-popup';
//   popup.className = 'triangulator-popup';

//   // Position the popup near the click
//   popup.style.position = 'fixed';
//   popup.style.right = '0';
//   popup.style.top = '50%';
//   popup.style.transform = 'translateY(-50%)';
//   popup.style.zIndex = '10000';

//   // Send message to background script to fetch course description first
//   chrome.runtime.sendMessage({
//     action: 'getCourseDescription',
//     courseData: courseData
//   }, (descriptionResponse) => {
//     if (chrome.runtime.lastError) {
//       console.error('Runtime error:', chrome.runtime.lastError);
//       popup.innerHTML = generatePopupHTML(courseData, null);
//       document.body.appendChild(popup);
//       initializePopupControls(popup);
//       return;
//     }

//     console.log('Received description from background:', descriptionResponse);

//     // Show popup immediately with description, loading state for matches
//     const description = descriptionResponse?.description || 'Course description not found in catalog.';
//     const fuzzy = descriptionResponse?.fuzzy || false;
//     const matchedCourse = descriptionResponse?.matched_course || null;
//     const similarity = descriptionResponse?.similarity || null;

//     popup.innerHTML = generatePopupHTML(courseData, { description, matches: null, loading: false, fuzzy, matchedCourse, similarity });
//     document.body.appendChild(popup);
//     initializePopupControls(popup);

//     // Only fetch matches if description was found
//     if (description !== 'Course description not found in catalog.') {
//       // Update to show loading
//       popup.innerHTML = generatePopupHTML(courseData, { description, matches: null, loading: true, fuzzy, matchedCourse, similarity });
//       initializePopupControls(popup);

//       // Now fetch matches in background
//       chrome.runtime.sendMessage({
//         action: 'getCourseMatches',
//         courseData: courseData,
//         description: description
//       }, (matchesResponse) => {
//         if (chrome.runtime.lastError) {
//           console.error('Error fetching matches:', chrome.runtime.lastError);
//           return;
//         }

//         console.log('Received matches from background:', matchesResponse);

//         if (matchesResponse && matchesResponse.success) {
//           // Update popup with matches
//           updatePopupWithMatches(popup, matchesResponse.matches);
//         }
//       });
//     }
//   });
// }

// // Function to generate popup HTML
// function generatePopupHTML(courseData, response) {
//   const hasMatches = response && response.matches && response.matches.length > 0;
//   const isLoading = response && response.loading;
//   const courseDescription = response?.description || 'Course data is currently unavailable for this listing. Please check back later or contact your institution admin for the latest catalog details.';
//   const fuzzy = response?.fuzzy || false;
//   const matchedCourse = response?.matchedCourse || null;
//   const similarity = response?.similarity || null;

//   return `
//     <section class="overlay" role="dialog" aria-labelledby="course-title">
//       <button class="overlay__action" type="button" aria-label="Close course details" aria-expanded="true"></button>
//       <div class="overlay__content">
//         <header>
//           <p class="institution">${courseData.institution || 'Institution'}</p>
//           <h1 id="course-title">
//             ${courseData.title || 'Course Title'}
//             <span class="course-meta">${courseData.subject} ${courseData.number} • ${courseData.hours} credit hours</span>
//           </h1>
//         </header>

//         <section class="description" aria-label="Course description">
//           <p class="section-label">Course Description</p>
//           ${fuzzy ? `
//             <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
//               <span style="font-size: 18px;">⚠️</span>
//               <span style="font-size: 0.85rem; color: #856404;">
//                 <strong>Fuzzy Match (${similarity}%):</strong> Exact course not found. Showing ${matchedCourse} instead.
//               </span>
//             </div>
//           ` : ''}
//           <p>${courseDescription}</p>
//         </section>

//         <div id="matches-container">
//           ${isLoading ? '<section class="matches"><p style="text-align: center; color: #666; padding: 20px;">Loading matches...</p></section>' : ''}
//           ${hasMatches ? generateMatchesHTML(response.matches) : ''}
//         </div>
//       </div>
//     </section>
//   `;
// }

// // Function to update popup with matches after they load
// function updatePopupWithMatches(popup, matches) {
//   const container = popup.querySelector('#matches-container');
//   if (!container) return;

//   if (matches && matches.length > 0) {
//     container.innerHTML = generateMatchesHTML(matches);
//     // Re-initialize carousel controls for the matches
//     const matchesSection = container.querySelector('.matches');
//     if (matchesSection) {
//       initializeMatchCarousel(matchesSection);
//     }
//   } else {
//     container.innerHTML = '';
//   }
// }

// // Initialize carousel for a specific matches section
// function initializeMatchCarousel(section) {
//   const cards = section.querySelectorAll('.match-card');
//   const buttons = section.querySelectorAll('.carousel-btn');
//   const indicators = section.querySelectorAll('.match-indicator');

//   if (!buttons.length || cards.length <= 1) return;

//   // Apply pie chart data
//   cards.forEach(card => {
//     const pieWrapper = card.querySelector('.match-score');
//     const pie = pieWrapper?.querySelector('.pie');
//     const pieValue = pie?.querySelector('.pie-value');
//     if (!pieWrapper || !pie) return;
//     const score = Number(card.dataset.score || 0);
//     const angle = Math.round((score / 100) * 360);
//     pie.style.setProperty('--pie-angle', `${angle}deg`);
//     if (pieValue) pieValue.textContent = `${score}%`;
//     pieWrapper.setAttribute('aria-label', `${score}% match`);
//   });

//   let index = 0;

//   const updateIndicator = () => {
//     indicators.forEach((indicator) => {
//       indicator.textContent = `${index + 1} of ${cards.length}`;
//     });
//   };

//   updateIndicator();

//   buttons.forEach((button) => {
//     button.addEventListener('click', () => {
//       cards[index].classList.remove('is-active');
//       index = (index + 1) % cards.length;
//       cards[index].classList.add('is-active');
//       updateIndicator();
//     });
//   });
// }

// // Function to generate matches HTML
// function generateMatchesHTML(matches) {
//   if (!matches || matches.length === 0) return '';

//   const matchCards = matches.map((match, index) => `
//     <article class="match-card ${index === 0 ? 'is-active' : ''}" data-index="${index}" data-score="${match.score}">
//       <div class="match-heading">
//         <h3>${match.title}</h3>
//         <div class="match-score" role="img" aria-label="${match.score}% match">
//           <span class="pie"><span class="pie-value">${match.score}%</span></span>
//         </div>
//       </div>
//       <span class="match-meta">${match.subject} ${match.number} • ${match.hours} credit hours</span>
//       <p>${match.description}</p>
//       <div class="match-controls">
//         <span class="match-indicator">1 of ${matches.length}</span>
//         ${matches.length > 1 ? '<button class="carousel-btn" type="button" aria-label="Show next match">→</button>' : ''}
//       </div>
//     </article>
//   `).join('');

//   return `
//     <section class="matches" aria-label="Equivalent courses">
//       <div class="match-carousel">
//         ${matchCards}
//       </div>
//     </section>
//   `;
// }

// // Function to initialize popup controls
// function initializePopupControls(popup) {
//   // Toggle button
//   const toggleBtn = popup.querySelector('.overlay__action');
//   const overlay = popup.querySelector('.overlay');

//   if (toggleBtn) {
//     toggleBtn.addEventListener('click', () => {
//       const collapsed = overlay.classList.toggle('is-collapsed');
//       toggleBtn.setAttribute('aria-expanded', String(!collapsed));
//     });
//   }

//   // Carousel controls
//   const matchesSection = popup.querySelector('.matches');
//   if (matchesSection) {
//     const cards = matchesSection.querySelectorAll('.match-card');
//     const buttons = matchesSection.querySelectorAll('.carousel-btn');
//     const indicators = matchesSection.querySelectorAll('.match-indicator');

//     if (buttons.length && cards.length > 1) {
//       let index = 0;

//       const applyPieData = (card) => {
//         const pieWrapper = card.querySelector('.match-score');
//         const pie = pieWrapper?.querySelector('.pie');
//         const pieValue = pie?.querySelector('.pie-value');
//         if (!pieWrapper || !pie) return;
//         const score = Number(card.dataset.score || 0);
//         const angle = Math.round((score / 100) * 360);
//         pie.style.setProperty('--pie-angle', `${angle}deg`);
//         if (pieValue) pieValue.textContent = `${score}%`;
//         pieWrapper.setAttribute('aria-label', `${score}% match`);
//       };

//       cards.forEach(applyPieData);

//       const updateIndicator = () => {
//         indicators.forEach((indicator) => {
//           indicator.textContent = `${index + 1} of ${cards.length}`;
//         });
//       };

//       buttons.forEach((button) => {
//         button.addEventListener('click', () => {
//           cards[index].classList.remove('is-active');
//           index = (index + 1) % cards.length;
//           cards[index].classList.add('is-active');
//           updateIndicator();
//         });
//       });
//     }
//   }

//   // Close on outside click
//   document.addEventListener('click', (e) => {
//     if (!popup.contains(e.target) && e.target !== popup) {
//       // Don't close immediately, allow user to interact
//     }
//   });

//   // Add ESC key to close
//   document.addEventListener('keydown', (e) => {
//     if (e.key === 'Escape') {
//       popup.remove();
//     }
//   });
// }

// // Listen for clicks on the page
// document.addEventListener('click', (event) => {
//   const target = event.target;

//   // Check if click is within a course row
//   const courseData = extractCourseData(target);

//   if (courseData) {
//     console.log('Course clicked:', courseData);
//     showTriangulatorPopup(courseData, event);
//   }
// });

// // Listen for messages from the popup or background script
// chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
//   if (request.action === 'ping') {
//     sendResponse({ status: 'active' });
//   }
//   return true;
// });



// content.js - Detects clicks on course rows in TCG interface

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

  // Position the popup near the click
  popup.style.position = 'fixed';
  popup.style.right = '0';
  popup.style.top = '50%';
  popup.style.transform = 'translateY(-50%)';
  popup.style.zIndex = '10000';

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
        </header>

        <section class="description" aria-label="Course description">
          <p class="section-label">Course Description</p>
          <p>${isLoading ? 'Loading description...' : courseDescription}</p>
        </section>

        <div id="matches-container">
          ${isLoading ? '<section class="matches"><p style="text-align: center; color: #666; padding: 20px;">Finding matches...</p></section>' : ''}
          ${isError ? `<section class="matches"><p style="text-align: center; color: #d32f2f; padding: 20px;">${response.error}</p></section>` : ''}
          ${hasMatches ? generateMatchesHTML(response.matches) : ''}
          ${!isLoading && !isError && !hasMatches ? '<section class="matches"><p style="text-align: center; color: #666; padding: 20px;">No equivalent courses found at ASU.</p></section>' : ''}
        </div>
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
      index = (index + 1) % cards.length;
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
        <span class="match-indicator">1 of ${matches.length}</span>
        ${matches.length > 1 ? '<button class="carousel-btn" type="button" aria-label="Show next match">→</button>' : ''}
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
    let startY = 0;
    let startTop = 0;

    toggleBtn.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      const rect = popup.getBoundingClientRect();
      startTop = rect.top;

      dragTimeout = setTimeout(() => {
        isDragging = true;
        popup.style.transition = 'none';
        e.preventDefault();
      }, 150);
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaY = e.clientY - startY;
      const newTop = startTop + deltaY;
      const maxTop = window.innerHeight - popup.offsetHeight;
      const clampedTop = Math.max(48, Math.min(newTop, maxTop));
      popup.style.top = `${clampedTop}px`;
      popup.style.transform = 'translateY(0)';
    });

    document.addEventListener('mouseup', (e) => {
      clearTimeout(dragTimeout);
      if (isDragging) {
        isDragging = false;
        popup.style.transition = '';
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
          index = (index + 1) % cards.length;
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