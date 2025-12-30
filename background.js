// background.js - Cloudflare Worker API integration

const API_CONFIG = {
  baseUrl: 'https://triangulator-api.ftessili.workers.dev'
};

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getCourseDescription') {
    fetchCourseDescription(request.courseData).then(data => {
      sendResponse(data); // Send full object
    });
    return true;
  }
  
  if (request.action === 'getCourseMatches') {
    fetchCourseMatches(request.courseData, request.description).then(response => {
      sendResponse(response);
    });
    return true;
  } 
});

// Fetch course description from Cloudflare Worker
async function fetchCourseDescription(courseData) {
  try {
    const params = new URLSearchParams({
      institution: courseData.institution,
      subject: courseData.subject,
      number: courseData.number
    });
    
    console.log('Fetching description:', `${API_CONFIG.baseUrl}/course?${params}`);
    
    const response = await fetch(`${API_CONFIG.baseUrl}/course?${params}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log('Full response from Worker:', data);
      return data; // Return full object with fuzzy, matched_course, similarity
    } else {
      console.error('Worker error:', response.status);
      return { description: 'Course description not found in catalog.' };
    }
  } catch (error) {
    console.error('Fetch error:', error);
    return { description: 'Course description not found in catalog.' };
  }
}

// Fetch ASU course matches from Cloudflare Worker
async function fetchCourseMatches(courseData, description) {
  try {
    console.log('Fetching matches for:', courseData.subject, courseData.number);
    
    const response = await fetch(`${API_CONFIG.baseUrl}/match`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        institution: courseData.institution,
        subject: courseData.subject,
        number: courseData.number,
        title: courseData.title,
        description: description,
        hours: courseData.hours
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('Matches:', data);
      
      if (data.matches && Array.isArray(data.matches)) {
        const matches = data.matches.map(match => ({
          title: match.title,
          subject: match.subject,
          number: match.number,
          hours: match.hours,
          score: match.score,
          description: match.description
        }));
        
        return {
          success: true,
          matches: matches
        };
      }
      
      return { success: true, matches: [] };
    } else {
      console.error('Match API error:', response.status);
      return { success: false, error: `API returned ${response.status}` };
    }
  } catch (error) {
    console.error('Match fetch error:', error);
    return { success: false, error: error.message };
  }
}

console.log('Triangulator extension background script loaded');