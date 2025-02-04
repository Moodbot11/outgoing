document.addEventListener('DOMContentLoaded', () => {
    fetchLeads();
    document.getElementById('leadForm').addEventListener('submit', handleFormSubmit);
    document.getElementById('searchInput').addEventListener('input', handleSearch);
});

async function fetchLeads() {
    try {
        const response = await fetch('/api/leads');
        const leads = await response.json();
        displayLeads(leads);
    } catch (error) {
        console.error('Error fetching leads:', error);
    }
}

function displayLeads(leads) {
    const tbody = document.querySelector('#leadsTable tbody');
    tbody.innerHTML = '';
    leads.forEach(lead => {
        const row = tbody.insertRow();
        row.innerHTML = `
            <td>${lead.name}</td>
            <td>${lead.email}</td>
            <td>${lead.phone_number}</td>
            <td>${lead.status}</td>
            <td>
                <button onclick="editLead(${lead.id})">Edit</button>
                <button onclick="deleteLead(${lead.id})">Delete</button>
            </td>
        `;
    });
}

async function handleFormSubmit(event) {
    event.preventDefault();
    const leadId = document.getElementById('leadId').value;
    const leadData = {
        name: document.getElementById('name').value,
        email: document.getElementById('email').value,
        phone_number: document.getElementById('phone').value,
        status: document.getElementById('status').value
    };

    try {
        if (leadId) {
            await updateLead(leadId, leadData);
        } else {
            await addLead(leadData);
        }
        fetchLeads();
        resetForm();
    } catch (error) {
        console.error('Error saving lead:', error);
    }
}

async function addLead(leadData) {
    await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leadData)
    });
}

async function updateLead(id, leadData) {
    await fetch(`/api/leads/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leadData)
    });
}

function editLead(id) {
    const row = document.querySelector(`#leadsTable tbody tr:nth-child(${id})`);
    document.getElementById('leadId').value = id;
    document.getElementById('name').value = row.cells[0].textContent;
    document.getElementById('email').value = row.cells[1].textContent;
    document.getElementById('phone').value = row.cells[2].textContent;
    document.getElementById('status').value = row.cells[3].textContent;
}

async function deleteLead(id) {
    if (confirm('Are you sure you want to delete this lead?')) {
        try {
            await fetch(`/api/leads/${id}`, { method: 'DELETE' });
            fetchLeads();
        } catch (error) {
            console.error('Error deleting lead:', error);
        }
    }
}

function resetForm() {
    document.getElementById('leadForm').reset();
    document.getElementById('leadId').value = '';
}

function handleSearch() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const rows = document.querySelectorAll('#leadsTable tbody tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(searchTerm) ? '' : 'none';
    });
}