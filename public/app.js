const $ = (id) => document.getElementById(id);

const state = {
    products: [],
    cart: new Map(),
    currency: 'cad',
    taxEnabled: false,
    tax: { 
        status: 'idle', 
        amount: 0, 
        exclusive: 0, 
        inclusive: 0, 
        total: 0, 
        notice: '' 
    }, 
    taxTimer: null, 
    taxRequestId: 0, 
    readers: [], 
    selectedReaderId: null, 
    reader: null, 
    paymentIntentId: null, 
    paymentSocket: null,
    reconnectTimer: null,
    reconnectAttempts: 0
};

const formatter = () => new Intl.NumberFormat('en-US', { style: 'currency', currency: state.currency.toUpperCase() });

const money = (minor) => formatter().format(Number(minor || 0) / 100);

async function api(path, options = {}) {
    const response = await fetch(path, { 
        credentials: 'same-origin', 
        ...options, 
        headers: { 
            ...(options.body ? { 'Content-Type': 'application/json' } : {}), 
            ...(options.headers || {}) 
        } 
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);

    return data;
}

function showNotice(message, kind = 'info', target = 'mainNotice') {
    const el = $(target); 
    el.textContent = message; 
    el.className = `notice show ${kind}`;
}

function hideNotice(target = 'mainNotice') {
    const el = $(target); 
    el.textContent = ""; 
    el.className = 'notice';
}

function showLogin() {
    $('loginView').classList.remove('hidden');
    $('posView').classList.add('hidden');
    $('logoutBtn').classList.add('hidden');
    $('readerPill').classList.add('hidden');
}

function showPos() { 
    $('loginView').classList.add('hidden');
    $('posView').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');
    $('readerPill').classList.remove('hidden');
}

async function boot() {
    try {
        const session = await api('/api/session');
        if (!session.authenticated) { showLogin(); return; }
        showPos();
        await Promise.all([loadProducts(), refreshReaders()]);
    } catch (error) {
        showLogin();
        showNotice(error.message, 'error', 'loginError');
    }
}

async function loadProducts() {
    hideNotice();
    $('productGrid').innerHTML = '<div class="empty">Loading products...</div>';
    try {
        const result = await api('/api/products');
        state.products = result.products;
        state.currency = result.currency || 'cad';
        state.taxEnabled = Boolean(result.taxEnabled);
        state.tax = { status: 'idle', amount: 0, exclusive: 0, inclusive: 0, total: 0, notice: '' };
        
        $('catalogSub').textContent = `${state.products.length} products available · ${state.currency.toUpperCase()}`;
        renderProducts();
        renderCart();
    
        if (!state.products.length) {
            showNotice('No active products with a default one-time price in the configured currency were found in Stripe.', 'info');
        }
    
        if (result.hasMore) {
            showNotice('More products not fetched. Cloudstripe currently supports a maximum of 100 active products.', 'info');
        }
    } catch (error) {
        $('productGrid').innerHTML = '';
        showNotice(error.message, 'error');
    }
}

async function refreshReaders() {
    try {
        const result = await api('/api/readers');
        state.readers = result.readers || [];

        if (!state.readers.some(reader => reader.id === state.selectedReaderId)) {
            state.selectedReaderId = null;
            const reader = state.readers.find(reader => reader.status === 'online') || state.readers[0];
            if (reader) {
                state.selectedReaderId = reader.id;
            }
        }

        renderReaderSelect();
        updateSelectedReader();
    } catch (error) {
        state.readers = []; state.reader = null;
        $('readerSelect').innerHTML = '<option value="">Readers unavailable</option>';
        $('readerSelect').disabled = true;
        $('readerPill').querySelector('.dot').className = 'dot offline';
        $('checkoutBtn').disabled = true;
        showNotice(error.message, 'error');
    }
}

function renderReaderSelect() {
    const select = $('readerSelect');
    select.innerHTML = '';
    if (!state.readers.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No readers configured';
        select.append(option);
        select.disabled = true;
        return;
    }

    for (const reader of state.readers) {
        const option = document.createElement('option');
        option.value = reader.id;
        option.textContent = `${reader.label}: ${reader.status}`;
        select.append(option);
    }

    const option = document.createElement('option');
    option.value = '_refreshReaders';
    option.textContent = 'Refresh Readers';
    select.append(option);

    select.value = state.selectedReaderId || '';
    select.disabled = state.readers.length === 1;
}

function updateSelectedReader() {
    state.reader = state.readers.find(reader => reader.id === state.selectedReaderId) || null;
    const online = state.reader?.status === 'online';

    $('readerPill').querySelector('.dot').className = 'dot ' + (online ? 'online' : 'offline');

    updateCartSummary();

    if (state.reader && !online) {
        showNotice(`${state.reader.label} is ${state.reader.status}. Choose an online reader before taking a payment.`, 'error');
    }
    else if (
        $('mainNotice').classList.contains('show') &&
        $('mainNotice').classList.contains('error') &&
        $('mainNotice').textContent.includes('reader')
    ) {
        hideNotice();
    }
}

function renderProducts() {
    const term = $('search').value.trim().toLowerCase();
    const products = state.products.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(term));

    $('productGrid').innerHTML = '';

    if (!products.length) {
        $('productGrid').innerHTML = '<div class="empty">No matching products.</div>';
        return;
    }

    for (const product of products) {
        const button = document.createElement('button');
        button.className = 'product';
        button.type = 'button';
    
        const image = document.createElement('div');
        image.className = 'product-img';

        if (product.image) {
            const img = document.createElement('img');
            img.src = product.image;
            img.alt = '';
            img.loading = 'lazy';
            img.onerror = () => { image.textContent = '＋'; };
            image.append(img);
        } else {
            image.textContent = '＋';
        }

        const body = document.createElement('div');
        body.className = 'product-body';
    
        const name = document.createElement('div');
        name.className = 'product-name';
        name.textContent = product.name;
    
        const desc = document.createElement('div');
        desc.className = 'product-desc';
        desc.textContent = product.description;
    
        const price = document.createElement('div');
        price.className = 'product-price';
        price.textContent = money(product.amount);
    
        body.append(name, desc, price);
        button.append(image, body);
    
        button.addEventListener('click', () => addToCart(product));
        
        $('productGrid').append(button);
    }
}

function addToCart(product) {
    const current = state.cart.get(product.priceId);
    if (current) {
        current.quantity = Math.min(100, current.quantity + 1);
    }
    else {
        state.cart.set(product.priceId, { ...product, quantity: 1 });
    }

    renderCart();
}

function changeQuantity(priceId, delta) {
    const item = state.cart.get(priceId);
    if (!item) {
        return;
    }

    item.quantity += delta;
    if (item.quantity <= 0) {
        state.cart.delete(priceId);
    } else {
        item.quantity = Math.min(100, item.quantity);
    }

    renderCart();
}

function renderCart() {
    const items = [...state.cart.values()];
    $('cartItems').innerHTML = '';

    if (!items.length) {
        $('cartItems').innerHTML = '<div class="empty">Your cart is empty.<br>Tap a product to get started.</div>';
    }

    for (const item of items) {
        const line = document.createElement('div');
        line.className = 'cart-line';
    
        const left = document.createElement('div');
        
        const name = document.createElement('div');
        name.className = 'line-name';
        name.textContent = item.name;
    
        const unit = document.createElement('div');
        unit.className = 'line-unit';
        unit.textContent = `${money(item.amount)} each`;
        left.append(name, unit);
    
        const right = document.createElement('div');
        right.className = 'line-right';
    
        const total = document.createElement('div');
        total.className = 'line-total';
        total.textContent = money(item.amount * item.quantity);
    
        const qty = document.createElement('div');
        qty.className = 'qty';
    
        const minus = document.createElement('button');
        minus.type = 'button';
        minus.textContent = '−';
        minus.setAttribute('aria-label', `Remove one ${item.name}`);
        minus.addEventListener('click', () => changeQuantity(item.priceId, -1));
    
        const number = document.createElement('span');
        number.textContent = item.quantity;
    
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.textContent = '+';
        plus.setAttribute('aria-label', `Add one ${item.name}`);
        plus.addEventListener('click', () => changeQuantity(item.priceId, 1));
    
        qty.append(minus, number, plus);
        right.append(total, qty);
        line.append(left, right);
        $('cartItems').append(line);
    }
    
    updateCartSummary();
    scheduleTaxPreview();
}

function updateCartSummary() {
    const items = [...state.cart.values()];
    const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = items.reduce((sum, item) => sum + item.amount * item.quantity, 0);
    
    $('cartCount').textContent = `${quantity} ${quantity === 1 ? 'item' : 'items'}`;
    $('subtotal').textContent = money(subtotal);
    $('taxRow').classList.toggle('hidden', !state.taxEnabled);
    
    if (state.taxEnabled) {
        switch (state.tax.status) {
            case 'ready':
                $('taxAmount').textContent = money(state.tax.amount);
                break;
            case 'error':
                $('taxAmount').textContent = 'Unavailable';
                break;
            case 'loading':
                $('taxAmount').textContent = 'Calculating...';
                break;
            default:
                $('taxAmount').textContent = money(0);
        }

        if (state.tax.inclusive > 0 && state.tax.exclusive === 0) {
            $('taxLabel').textContent = 'Tax (included)';
        } else if (state.tax.exclusive > 0 && state.tax.inclusive === 0) {
            $('taxLabel').textContent = 'Tax (added)';
        } else {
            $('taxLabel').textContent = 'Tax';
        }
    }

    $('taxNote').textContent = state.tax.notice || '';
    $('taxNote').classList.toggle('hidden', !state.tax.notice);

    if (state.taxEnabled && state.tax.status === 'ready') {
        $('total').textContent = money(state.tax.total);
    } else {
        $('total').textContent = money(subtotal);
    }

    $('clearBtn').disabled = !items.length;
    $('checkoutBtn').disabled = !items.length || state.reader?.status !== 'online' || (state.taxEnabled && state.tax.status !== 'ready');
}

function scheduleTaxPreview() {
    if (state.taxTimer) {
        clearTimeout(state.taxTimer);
    }

    const items = [...state.cart.values()];

    if (!state.taxEnabled || !items.length) {
        state.taxRequestId++;
        state.tax = { status: 'idle', amount: 0, exclusive: 0, inclusive: 0, total: 0, notice: '' };
        updateCartSummary();
        return;
    }

    const requestId = ++state.taxRequestId;
    state.tax = { status: 'loading', amount: 0, exclusive: 0, inclusive: 0, total: 0, notice: '' };
    updateCartSummary();
    state.taxTimer = setTimeout(async () => {
        try {
            const result = await api('/api/tax-preview', {
                method: 'POST',
                body: JSON.stringify({ items: items.map(item => ({ priceId: item.priceId, quantity: item.quantity })) })
            });

            if (requestId !== state.taxRequestId) {
                return;
            }

            state.tax = {
                status: 'ready',
                amount: Number(result.taxAmount || 0),
                exclusive: Number(result.taxAmountExclusive || 0),
                inclusive: Number(result.taxAmountInclusive || 0),
                total: Number(result.amountTotal || subtotalFromCart()),
                notice: result.breakdown?.some(entry => entry.reason === 'not_collecting') ?
                    'One or more items are not having tax collected. Check their Stripe tax codes and your active tax registrations.' : ''
            };
        
            updateCartSummary();
            hideNotice();
        } catch (error) {
            if (requestId !== state.taxRequestId) {
                return;
            }

            state.tax = {
                status: 'error',
                amount: 0,
                exclusive: 0,
                inclusive: 0,
                total: 0,
                notice: ''
            };
        
            updateCartSummary();
            showNotice(`Tax could not be calculated. Checkout is disabled to avoid charging the wrong amount. ${error.message}`, 'error');
        }
    }, 250);
}

function subtotalFromCart() {
    return [...state.cart.values()].reduce((sum, item) => sum + item.amount * item.quantity, 0);
}

function bindCancelButton() {
    const button = $('cancelPaymentBtn');
    if (button) {
        button.addEventListener('click', cancelCurrentPayment);
    }
}

async function cancelCurrentPayment() {
    if (!state.paymentIntentId) {
        $('paymentModal').classList.remove('show');
        return;
    }

    $('cancelPaymentBtn').disabled = true;

    try {
        await api('/api/cancel', { method: 'POST', body: JSON.stringify({ paymentIntentId: state.paymentIntentId }) });
        refreshPaymentStatus();

        $('paymentTitle').textContent = 'Cancellation requested';
        $('paymentMessage').textContent = 'Checking the final payment status…';
        connectPaymentSocket();
    } catch (error) {
        $('paymentMessage').textContent = error.message;
        $('cancelPaymentBtn').disabled = false;
    }
}

async function refreshPaymentStatus() {
    if (!state.paymentIntentId) {
        return;
    }

    try {
        const result = await api(`/api/payment/${encodeURIComponent(state.paymentIntentId)}`);

        if (result.state === 'succeeded') {
            state.polling = false;
            $('paymentSpinner').classList.add('hidden');
            $('paymentTitle').textContent = 'Payment approved';

            const taxWarning = result.taxRecordStatus === 'failed' ? ` However, Stripe Tax could not record this sale: ${result.taxRecordMessage || 'unknown error'}. Retry tax recording before closing.` : '';
            const taxRecorded = result.taxRecordStatus === 'recorded' ? ' The tax transaction was recorded in Stripe.' : '';

            $('paymentMessage').textContent = `${money(result.amount)} was successfully paid.${taxRecorded}${taxWarning}`;
            $('paymentActions').innerHTML = result.taxRecordStatus === 'failed' ? '<button class="secondary" id="retryTaxBtn">Retry tax recording</button><button class="primary" id="doneBtn">Done</button>' : '<button class="primary" id="doneBtn">Done</button>';
            $('doneBtn').addEventListener('click', finishSale);

            const retryTaxBtn = $('retryTaxBtn');

            if (retryTaxBtn) {
                retryTaxBtn.addEventListener('click', () => {
                    $('paymentSpinner').classList.remove('hidden');
                    $('paymentTitle').textContent = 'Retrying tax record';
                    $('paymentMessage').textContent = 'Checking Stripe Tax transaction status…';
                    refreshPaymentStatus();
                });
            }

            return;
        }

        if (result.state === 'failed') {
            state.polling = false;
            $('paymentSpinner').classList.add('hidden');
            $('paymentTitle').textContent = 'Payment not completed';
            $('paymentMessage').textContent = result.failureMessage || 'The card was not accepted. You can try another card using the same payment.';
            $('paymentActions').innerHTML = '<button class="secondary" id="retryBtn">Try another card</button><button class="secondary" id="closeBtn">Close</button>';
            $('retryBtn').addEventListener('click', retryCurrentPayment);
            $('closeBtn').addEventListener('click', closePayment);

            return;
        }

        if (result.state === 'canceled' || result.readerActionStatus === 'canceled') {
            state.polling = false;
            $('paymentSpinner').classList.add('hidden');
            $('paymentTitle').textContent = 'Payment canceled';
            $('paymentMessage').textContent = 'No successful payment was reported. Close this message to return to the cart.';
            $('paymentActions').innerHTML = '<button class="secondary" id="closeBtn">Close</button>';
            $('closeBtn').addEventListener('click', closePayment); return;
        }

        $('paymentMessage').textContent = result.readerStatus === 'online' ? `${result.readerLabel} is waiting for the customer. Ask them to tap or insert their card.` : `The connection to ${result.readerLabel} changed. Checking payment status…`;
    } catch (error) {
        $('paymentMessage').textContent = `Unable to check status: ${error.message}. Do not start another payment until you verify the reader and Stripe Dashboard.`;
    }
}

async function retryCurrentPayment() {
    $('retryBtn').disabled = true;
    $('paymentTitle').textContent = 'Retrying payment';
    $('paymentMessage').textContent = 'Please wait while the same payment is sent to the reader.';
    $('paymentSpinner').classList.remove('hidden');
    $('paymentActions').innerHTML = '<button class="secondary" id="cancelPaymentBtn">Cancel payment</button>';

    bindCancelButton();

    try {
        await api('/api/retry', { method: 'POST', body: JSON.stringify({ paymentIntentId: state.paymentIntentId }) });
        refreshPaymentStatus();
        connectPaymentSocket();
    } catch (error) {
        $('paymentSpinner').classList.add('hidden'); $('paymentMessage').textContent = error.message;
        $('paymentActions').innerHTML = '<button class="secondary" id="closeBtn">Close</button>';
        $('closeBtn').addEventListener('click', closePayment);
    }
}

function closePayment() {
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }

    if (state.paymentSocket) {
        state.paymentSocket.close();
        state.paymentSocket = null;
    }

    state.reconnectAttempts = 0;

    $('paymentModal').classList.remove('show');
    state.paymentIntentId = null;

    renderReaderSelect();
    renderCart();
}

function finishSale() {
    state.cart.clear();
    renderCart();
    closePayment();
    refreshReaders();
}

function connectPaymentSocket() {
    if (!state.paymentIntentId) {
        return;
    }

    if (state.paymentSocket) {
        state.paymentSocket.close();
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/api/payment/` +
        `${encodeURIComponent(state.paymentIntentId)}/ws`;

    const socket = new WebSocket(url);
    state.paymentSocket = socket;

    socket.addEventListener('open', () => {
        if (state.paymentSocket !== socket) {
            return;
        }

        state.reconnectAttempts = 0;

        // Reconcile state in case we missed an event.
        refreshPaymentStatus();
    });

    socket.addEventListener('message', event => {
        if (state.paymentSocket !== socket) {
            return;
        }

        try {
            const message = JSON.parse(event.data);

            if (message.type === 'payment.updated') {
                refreshPaymentStatus();
            }
        } catch (error) {
            console.error('Invalid payment WebSocket message:', error);
        }
    });

    socket.addEventListener('close', () => {
        if (state.paymentSocket !== socket) {
            return;
        }
        state.paymentSocket = null;

        if (!state.paymentIntentId) {
            return;
        }

        const delay = Math.min(
            1000 * 2 ** state.reconnectAttempts++,
            30000
        );

        state.reconnectTimer = setTimeout(
            connectPaymentSocket,
            delay
        );
    });

    socket.addEventListener('error', () => {
        socket.close();
    });
}

////////////////////////////////// Event listeners

// Login
$('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('loginBtn').disabled = true;
    hideNotice('loginError');

    try {
        await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
        $('password').value = '';
        showPos();
        await Promise.all([loadProducts(), refreshReaders()]);
    } catch (error) {
        showNotice(error.message, 'error', 'loginError');
    }
    finally {
        $('loginBtn').disabled = false;
    }
});

// Logout
$('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
    state.cart.clear();
    showLogin();
});

// Select new reader
$('readerSelect').addEventListener('change', () => {
    if ($('paymentModal').classList.contains('show')) {
        $('readerSelect').value = state.selectedReaderId || '';
        return;
    }

    if ($('readerSelect').value === '_refreshReaders') {
        refreshReaders();
        $('readerSelect').value = state.selectedReaderId || '';
        return;
    }

    state.selectedReaderId = $('readerSelect').value || null;
    updateSelectedReader();
});

// Search
$('search').addEventListener('input', renderProducts);

// Clear cart
$('clearBtn').addEventListener('click', () => { state.cart.clear(); renderCart(); });

// Checkout
$('checkoutBtn').addEventListener('click', async () => {
    if (!state.cart.size || state.reader?.status !== 'online') {
        return;
    }

    $('checkoutBtn').disabled = true;
    hideNotice();
    $('paymentTitle').textContent = 'Sending payment to terminal';
    $('paymentMessage').textContent = 'The reader is being prepared. Please wait.';
    $('paymentSpinner').classList.remove('hidden');
    $('paymentActions').innerHTML = '<button class="secondary" id="cancelPaymentBtn">Cancel payment</button>';
    $('paymentModal').classList.add('show');
    $('readerSelect').disabled = true;
    bindCancelButton();

    try {
        const result = await api('/api/checkout', {
            method: 'POST',
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({
                readerId: state.selectedReaderId,
                items: [...state.cart.values()].map(item => ({ priceId: item.priceId, quantity: item.quantity }))
            })
        });

        state.paymentIntentId = result.paymentIntentId;
        $('paymentTitle').textContent = 'Waiting for customer';
        $('paymentMessage').textContent = `Please ask the customer to tap or insert their card on ${result.readerLabel}. `;
        if (result.taxEnabled) {
            $('paymentMessage').textContent += `Subtotal: ${money(result.subtotal)} · Tax: ${money(result.taxAmount)} · `;
        }
        $('paymentMessage').textContent += `Total: ${money(result.amount)}.`;

        connectPaymentSocket();
    } catch (error) {
        $('paymentModal').classList.remove('show');
        showNotice(error.message, 'error');
        $('checkoutBtn').disabled = false;
        await refreshReaders();
    }
});

////////////////////////////////// Boot
boot();
