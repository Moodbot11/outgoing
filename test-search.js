import fetch from 'node-fetch';

async function testSearch() {
  const baseUrl = 'http://localhost:80';
  const searchQuery = 'test';
  const numResults = 5;
  const sortBy = 'date';

  try {
    const response = await fetch(`${baseUrl}/test-search?q=${searchQuery}&num_results=${numResults}&sort_by=${sortBy}`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Search results:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error testing search:', error);
  }
}

testSearch();