const today = new Date();

const state = {
  years: [],
  year: today.getFullYear(),
  month: today.getMonth(),
  slots: [],
  isAdmin: false,
  adminUiOpen: false,
  selectedSlotId: null,
  selectedCancelSlotId: null
};

const bookingForm = document.querySelector('#booking-form');
const bookingMessage = document.querySelector('#booking-message');
const cancelForm = document.querySelector('#cancel-form');
const cancelMessage = document.querySelector('#cancel-message');
const sendCancelCodeButton = document.querySelector('#send-cancel-code');
const cancelEmailInput = document.querySelector('#cancel-email');
const cancelCodeInput = document.querySelector('#cancel-code');
const calendarGrid = document.querySelector('#calendar-grid');
const monthLabel = document.querySelector('#month-label');
const monthPrev = document.querySelector('#month-prev');
const monthNext = document.querySelector('#month-next');
const selectedSlotIdInput = document.querySelector('#selected-slot-id');
const selectedSlotHint = document.querySelector('#selected-slot-hint');
const selectedCancelSlotHint = document.querySelector('#selected-cancel-slot-hint');

const adminLoginForm = document.querySelector('#admin-login-form');
const adminPassword = document.querySelector('#admin-password');
const adminMessage = document.querySelector('#admin-message');
const adminPanel = document.querySelector('#admin-panel');
const adminShell = document.querySelector('#admin-shell');
const adminToggle = document.querySelector('#admin-toggle');
const adminList = document.querySelector('#admin-list');
const adminLogout = document.querySelector('#admin-logout');

const adminTemplate = document.querySelector('#admin-item-template');
const CANCEL_STEPS_TEXT = `1. Select your booked day in the calendar.
2. Enter your email.
3. Enter the recieved verification code. Click cancel.`;

init().catch((error) => {
  console.error(error);
  setMessage(bookingMessage, 'Could not load the page.', true);
});

async function init() {
  await loadYears();
  await checkAdmin();
  await loadSlots();
  bindEvents();
  syncAdminShell();
}

function bindEvents() {
  monthPrev.addEventListener('click', async () => {
    await changeMonth(-1);
  });
  monthNext.addEventListener('click', async () => {
    await changeMonth(1);
  });
  calendarGrid.addEventListener('click', (event) => {
    const cell = event.target.closest('.day-cell');
    if (!cell) {
      return;
    }

    const slotId = Number(cell.dataset.slotId);
    if (!Number.isInteger(slotId) || slotId <= 0) {
      return;
    }

    const slot = state.slots.find((item) => item.id === slotId);
    if (!slot || slotEndDate(slot) <= new Date()) {
      return;
    }

    if (slot.status === 'open') {
      state.selectedSlotId = slotId;
      state.selectedCancelSlotId = null;
      setMessage(bookingMessage, '');
    } else if (slot.status === 'booked') {
      state.selectedCancelSlotId = slotId;
      state.selectedSlotId = null;
      setMessage(cancelMessage, '');
    } else {
      setMessage(bookingMessage, 'This slot is closed.', true);
      return;
    }

    syncSelectedSlot();
    syncSelectedCancelSlot();
    renderCalendar();
  });

  bookingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.selectedSlotId) {
      setMessage(bookingMessage, 'Select an available day in the calendar first.', true);
      return;
    }
    setMessage(bookingMessage, 'Saving booking...');

    const payload = {
      slotId: state.selectedSlotId,
      email: document.querySelector('#email').value,
      name: document.querySelector('#name').value,
      agency: document.querySelector('#agency').value
    };

    try {
      const response = await api('/api/public/book', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      setMessage(bookingMessage, response.message || 'Booking saved.', false, true);
      bookingForm.reset();
      state.selectedSlotId = null;
      syncSelectedSlot();
      await loadSlots();
    } catch (error) {
      setMessage(bookingMessage, error.message, true);
    }
  });

  sendCancelCodeButton.addEventListener('click', async () => {
    if (!state.selectedCancelSlotId) {
      setMessage(cancelMessage, 'Select your booked day in the calendar first.', true);
      return;
    }

    const email = cancelEmailInput.value.trim();
    if (!email) {
      setMessage(cancelMessage, 'Enter your booking email first.', true);
      return;
    }

    setMessage(cancelMessage, 'Sending verification code...');
    try {
      const response = await api('/api/public/cancel/request-code', {
        method: 'POST',
        body: JSON.stringify({
          slotId: state.selectedCancelSlotId,
          email
        })
      });

      if (response.devCode) {
        setMessage(cancelMessage, `${response.message} Code: ${response.devCode}`, false, true);
      } else {
        setMessage(cancelMessage, response.message || 'Verification code sent.', false, true);
      }
    } catch (error) {
      setMessage(cancelMessage, error.message, true);
    }
  });

  cancelForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.selectedCancelSlotId) {
      setMessage(cancelMessage, 'Select your booked day in the calendar first.', true);
      return;
    }

    const email = cancelEmailInput.value.trim();
    const code = cancelCodeInput.value.trim();
    if (!email || !code) {
      setMessage(cancelMessage, 'Enter both email and verification code.', true);
      return;
    }

    setMessage(cancelMessage, 'Canceling booking...');
    try {
      const response = await api('/api/public/cancel/confirm', {
        method: 'POST',
        body: JSON.stringify({
          slotId: state.selectedCancelSlotId,
          email,
          code
        })
      });

      setMessage(cancelMessage, response.message || 'Booking canceled.', false, true);
      state.selectedCancelSlotId = null;
      cancelForm.reset();
      syncSelectedCancelSlot();
      await loadSlots();
    } catch (error) {
      setMessage(cancelMessage, error.message, true);
    }
  });

  adminToggle.addEventListener('click', () => {
    state.adminUiOpen = !state.adminUiOpen;
    syncAdminShell();
  });

  adminLoginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage(adminMessage, 'Logging in...');

    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: adminPassword.value })
      });
      adminPassword.value = '';
      await checkAdmin();
      await loadSlots();
      setMessage(adminMessage, 'Logged in as admin.', false, true);
    } catch (error) {
      setMessage(adminMessage, error.message, true);
    }
  });

  adminLogout.addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' });
      await checkAdmin();
      setMessage(adminMessage, 'Logged out.', false, true);
    } catch (error) {
      setMessage(adminMessage, error.message, true);
    }
  });

  adminList.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) {
      return;
    }

    const item = button.closest('.admin-item');
    if (!item) {
      return;
    }

    const slotId = Number(item.dataset.slotId);

    if (button.classList.contains('apply-close')) {
      const closed = item.querySelector('.close-toggle').checked;
      const reason = item.querySelector('.close-reason').value;
      try {
        await api(`/api/admin/slots/${slotId}/close`, {
          method: 'POST',
          body: JSON.stringify({ closed, reason })
        });
        setMessage(adminMessage, 'Change saved.', false, true);
        await loadSlots();
      } catch (error) {
        setMessage(adminMessage, error.message, true);
      }
    }

    if (button.classList.contains('clear-booking')) {
      try {
        await api(`/api/admin/slots/${slotId}/clear-booking`, { method: 'POST' });
        setMessage(adminMessage, 'Booking removed.', false, true);
        await loadSlots();
      } catch (error) {
        setMessage(adminMessage, error.message, true);
      }
    }
  });
}

async function loadYears() {
  const data = await api('/api/public/years');
  state.years = data.years;
  if (!state.years.includes(state.year)) {
    state.year = state.years[0];
  }
}

async function checkAdmin() {
  try {
    await api('/api/admin/me');
    state.isAdmin = true;
  } catch {
    state.isAdmin = false;
  }

  adminPanel.classList.toggle('hidden', !state.isAdmin);
  adminLogout.classList.toggle('hidden', !state.isAdmin);
  adminLoginForm.classList.toggle('hidden', state.isAdmin);
  if (state.isAdmin) {
    state.adminUiOpen = true;
  }
  syncAdminShell();
}

async function loadSlots() {
  const endpoint = state.isAdmin
    ? `/api/admin/slots?year=${state.year}`
    : `/api/public/slots?year=${state.year}`;
  const data = await api(endpoint);
  state.slots = data.slots;
  keepSelectedSlotIfStillBookable();
  keepSelectedCancelSlotIfStillCancelable();
  syncSelectedSlot();
  syncSelectedCancelSlot();
  renderCalendar();

  if (state.isAdmin) {
    renderAdminList();
  }
}

function renderCalendar() {
  const monthSlots = state.slots.filter((slot) => {
    const date = new Date(`${slot.date}T00:00:00`);
    return date.getMonth() === state.month;
  });
  const slotByDate = new Map(monthSlots.map((slot) => [slot.date, slot]));

  monthLabel.textContent = monthLabelText(state.year, state.month);
  calendarGrid.innerHTML = '';

  const weekdays = ['Week', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (const label of weekdays) {
    const header = document.createElement('div');
    header.className = 'month-head';
    header.textContent = label;
    calendarGrid.append(header);
  }

  const firstDay = new Date(state.year, state.month, 1);
  const lastDay = new Date(state.year, state.month + 1, 0);
  const firstOffset = (firstDay.getDay() + 6) % 7;
  const lastOffset = 6 - ((lastDay.getDay() + 6) % 7);

  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstOffset);
  const gridEnd = new Date(lastDay);
  gridEnd.setDate(lastDay.getDate() + lastOffset);

  for (let weekStart = new Date(gridStart); weekStart <= gridEnd; weekStart.setDate(weekStart.getDate() + 7)) {
    const weekCell = document.createElement('div');
    weekCell.className = 'week-number';
    weekCell.textContent = String(isoWeek(toIsoDate(weekStart)));
    calendarGrid.append(weekCell);

    for (let offset = 0; offset < 7; offset += 1) {
      const day = new Date(weekStart);
      day.setDate(weekStart.getDate() + offset);

      const dayIso = toIsoDate(day);
      const slot = slotByDate.get(dayIso);
      const inMonth = day.getMonth() === state.month;

      const cell = document.createElement('div');
      cell.className = 'day-cell';
      if (!inMonth) {
        cell.classList.add('outside-month');
      }
      if (slot) {
        cell.classList.add(`status-${slot.status}`);
      }
      if (slot) {
        cell.dataset.slotId = String(slot.id);
      }
      if (slot && inMonth && slot.status === 'open' && slotEndDate(slot) > new Date()) {
        cell.classList.add('bookable');
      }
      if (slot && inMonth && slot.status === 'booked' && slotEndDate(slot) > new Date()) {
        cell.classList.add('cancelable');
      }
      if (slot && slot.id === state.selectedSlotId) {
        cell.classList.add('selected');
      }
      if (slot && slot.id === state.selectedCancelSlotId) {
        cell.classList.add('selected-cancel');
      }

      const dayNumber = document.createElement('p');
      dayNumber.className = 'day-number';
      dayNumber.textContent = String(day.getDate());
      cell.append(dayNumber);

      if (slot) {
        const slotTime = document.createElement('p');
        slotTime.className = 'day-time';
        slotTime.textContent = `${slot.startTime}-${slot.endTime}`;
        cell.append(slotTime);

        const slotText = document.createElement('p');
        slotText.className = 'day-status';
        slotText.textContent = calendarStatusText(slot);
        cell.append(slotText);

        if (slot.status === 'booked') {
          const bookedBy = slot.bookedName || 'Unknown';
          const bookedAgency = slot.bookedAgency ? ` (${slot.bookedAgency})` : '';
          cell.title = `Booked by ${bookedBy}${bookedAgency}`;
        } else if (slot.status === 'closed') {
          cell.title = slot.closedReason
            ? `Closed: ${slot.closedReason}`
            : 'Closed';
        }
      }

      calendarGrid.append(cell);
    }
  }
}

function renderAdminList() {
  adminList.innerHTML = '';

  for (const slot of state.slots) {
    const node = adminTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.slotId = String(slot.id);

    node.querySelector('.slot-date').textContent = `${formatDate(slot.date)} (${slot.startTime}-${slot.endTime})`;
    node.querySelector('.slot-booking').textContent = adminBookingText(slot);

    const toggle = node.querySelector('.close-toggle');
    const reason = node.querySelector('.close-reason');
    toggle.checked = slot.status === 'closed';
    reason.value = slot.closedReason || '';

    const clearButton = node.querySelector('.clear-booking');
    if (slot.status !== 'booked') {
      clearButton.disabled = true;
    }

    adminList.append(node);
  }
}

function adminBookingText(slot) {
  if (slot.status === 'booked') {
    const parts = [slot.bookedName || 'Unknown', slot.bookedEmail || '', slot.bookedAgency || ''];
    return `Booked: ${parts.filter(Boolean).join(' - ')}`;
  }
  if (slot.status === 'closed') {
    return `Closed${slot.closedReason ? ` (${slot.closedReason})` : ''}`;
  }
  return 'Available';
}

function setMessage(element, text, isError = false, isSuccess = false) {
  element.textContent = text || '';
  element.classList.toggle('error', Boolean(isError));
  element.classList.toggle('success', Boolean(isSuccess));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }

  return data;
}

function formatDate(dateString) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
}

function slotEndDate(slot) {
  return new Date(`${slot.date}T${slot.endTime}:00`);
}

function isoWeek(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const dayNumber = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  return 1 + Math.round((date - firstThursday) / 604800000);
}

function toIsoDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthLabelText(year, month) {
  const date = new Date(year, month, 1);
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function calendarStatusText(slot) {
  if (slot.status === 'open') {
    return 'Available';
  }
  if (slot.status === 'booked') {
    return slot.bookedName ? `Booked (${slot.bookedName})` : 'Booked';
  }
  return 'Closed';
}

async function changeMonth(delta) {
  const next = new Date(state.year, state.month + delta, 1);
  const yearChanged = next.getFullYear() !== state.year;
  state.year = next.getFullYear();
  state.month = next.getMonth();

  if (yearChanged) {
    await loadSlots();
    return;
  }
  renderCalendar();
}

function syncSelectedSlot() {
  selectedSlotIdInput.value = state.selectedSlotId ? String(state.selectedSlotId) : '';
  if (!state.selectedSlotId) {
    selectedSlotHint.textContent = 'Select an available day in the calendar.';
    return;
  }

  const slot = state.slots.find((item) => item.id === state.selectedSlotId);
  if (!slot) {
    selectedSlotHint.textContent = 'Select an available day in the calendar.';
    return;
  }

  selectedSlotHint.textContent = '';
  const label = document.createElement('strong');
  label.textContent = 'Selected slot:\u00A0';
  selectedSlotHint.append(
    label,
    document.createTextNode(`${formatDate(slot.date)} at ${slot.startTime}-${slot.endTime}.`)
  );
}

function keepSelectedSlotIfStillBookable() {
  if (!state.selectedSlotId) {
    return;
  }

  const selected = state.slots.find((slot) => slot.id === state.selectedSlotId);
  if (!selected || selected.status !== 'open' || slotEndDate(selected) <= new Date()) {
    state.selectedSlotId = null;
  }
}

function syncSelectedCancelSlot() {
  selectedCancelSlotHint.textContent = CANCEL_STEPS_TEXT;
}

function keepSelectedCancelSlotIfStillCancelable() {
  if (!state.selectedCancelSlotId) {
    return;
  }

  const selected = state.slots.find((slot) => slot.id === state.selectedCancelSlotId);
  if (!selected || selected.status !== 'booked' || slotEndDate(selected) <= new Date()) {
    state.selectedCancelSlotId = null;
  }
}

function syncAdminShell() {
  const open = Boolean(state.adminUiOpen || state.isAdmin);
  adminShell.classList.toggle('hidden', !open);
  adminToggle.setAttribute('aria-expanded', String(open));
  adminToggle.textContent = open ? 'close admin' : 'admin';
}
