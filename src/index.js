const COOKIE_NAME = "cstripe_session";
const SESSION_SECONDS = 16 * 60 * 60;
const MAX_CART_LINES = 20;
const MAX_QUANTITY = 100;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/api/")) {
            try {
                return await handleApi(request, env, url);
            } catch (error) {
                console.error("POS API error:", error?.message || error);
                return json({ error: error?.publicMessage || "The request could not be completed." }, error?.status || 500);
            }
        }

        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("X-Frame-Options", "DENY");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    }
};

async function handleApi(request, env, url) {
    const pathParts = url.pathname.split("/");

    if (pathParts.length < 3 || pathParts[1] !== "api") {
        return json({ error: "Not found." }, 404);
    }

    const baseName = pathParts[2];

    // All the endpoints that you don't need to be logged in for.
    switch (`${request.method} ${baseName}`) {
        case "POST login":
            assertSameOrigin(request, url);
            requireEnv(env, ["POS_PASSWORD", "SESSION_SECRET"]);
            const body = await readJson(request);

            if (typeof body.password !== "string" || !constantTimeEqual(body.password, env.POS_PASSWORD)) {
                return json({ error: "Incorrect password." }, 401);
            }

            const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
            const nonce = crypto.randomUUID();
            const payload = `${expiry}.${nonce}`;
            const signature = await hmac(payload, env.SESSION_SECRET);

            return json({ ok: true }, 200, {
                "Set-Cookie": `${COOKIE_NAME}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
                "Cache-Control": "no-store"
            });
    
        case "POST logout":
            assertSameOrigin(request, url);

            return json({ ok: true }, 200, {
                "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
                "Cache-Control": "no-store"
            });

        case "GET session":
            return json({ authenticated: await isAuthenticated(request, env) }, 200, { "Cache-Control": "no-store" });
  
        case "POST stripe-webhook":
            return stripeWebhook(request, env);
    }

    if (!(await isAuthenticated(request, env))) {
        return json({ error: "Please sign in again." }, 401);
    }

    // All the end points that you do need to be logged in for.
    switch (`${request.method} ${baseName}`) {
        case "GET products":
            return listProducts(env);
  
        case "GET readers":
            return readersStatus(env);
  
        case "POST tax-preview":
            assertSameOrigin(request, url);
            return taxPreview(request, env);
  
        case "POST checkout":
            assertSameOrigin(request, url);
            return startCheckout(request, env);
  
        case "POST cancel":
            assertSameOrigin(request, url);
            return cancelPayment(request, env);
  
        case "POST retry":
            assertSameOrigin(request, url);
            return retryPayment(request, env);
  
        case "GET payment":
            if (pathParts.length < 4) {
                return json({ error: "Not found." }, 404);
            }
            return paymentStatus(env, pathParts[3]);
    }

    return json({ error: "Not found." }, 404);
}

async function listProducts(env) {
    requireEnv(env, ["STRIPE_SECRET_KEY"]);
    const currency = (env.POS_CURRENCY || "cad").toLowerCase();
    const params = new URLSearchParams({ active: "true", limit: "100" });
    params.append("expand[]", "data.default_price");
    const result = await stripe(env, `/v1/products?${params.toString()}`);

    const products = (result.data || []).flatMap((product) => {
        const price = product.default_price;

        if (!product.active || !price || typeof price !== "object" || !price.active) {
            return [];
        }

        if (price.type === "recurring" || price.unit_amount == null || price.currency !== currency) {
            return [];
        }

        return [{
            productId: product.id,
            priceId: price.id,
            name: product.name,
            description: product.description || "",
            image: Array.isArray(product.images) ? product.images[0] || null : null,
            amount: Number(price.unit_amount),
            currency: price.currency
        }];
    });

    const taxEnabled = taxIsEnabled(env);
    if (taxEnabled) {
        // Fail visibly if tax is enabled but the POS location is incomplete.
        taxAddress(env);
    }

    return json({ products, currency, taxEnabled, hasMore: Boolean(result.has_more) }, 200, { "Cache-Control": "private, max-age=30" });
}

function configuredReaders(env) {
    requireEnv(env, ["POS_READERS"]);
    let configured;
    try {
        configured = JSON.parse(env.POS_READERS);
    }
    catch {
        const error = new Error("POS_READERS must be valid JSON.");
        error.status = 503;
        error.publicMessage = "The POS reader list is incorrectly configured. Ask your administrator to check POS_READERS.";
        throw error;
    }

    if (!Array.isArray(configured) || configured.length < 1) {
        const error = new Error("POS_READERS must be an array containing at least one reader.");
        error.status = 503;
        error.publicMessage = "Configure at least one reader in POS_READERS.";
        throw error;
    }

    const seen = new Set();
    return configured.map((entry) => {
        const id = typeof entry === "string" ? entry : entry?.id;
        const label = typeof entry === "string" ? "Stripe reader" : (entry?.label || "Stripe reader");

        if (typeof id !== "string" || !/^tmr_[A-Za-z0-9]+$/.test(id) || typeof label !== "string" || seen.has(id)) {
            const error = new Error("POS_READERS contains an invalid or duplicate reader entry.");
            error.status = 503;
            error.publicMessage = "The POS reader list contains an invalid or duplicate reader. Check POS_READERS.";
            throw error;
        }
        seen.add(id);
        return { id, label };
    });
}

function configuredReader(env, readerId) {
    const reader = configuredReaders(env).find((candidate) => candidate.id === readerId);
    if (!reader) {
        const error = new Error("The requested reader is not configured for this POS.");
        error.status = 400;
        error.publicMessage = "That reader is not available in this POS. Refresh the page and choose a configured reader.";
        throw error;
    }
    return reader;
}

async function fetchReaderStatus(env, configured) {
    const reader = await stripe(env, `/v1/terminal/readers/${encodeURIComponent(configured.id)}`);

    return {
        id: reader.id,
        label: configured.label || reader.label || "Stripe reader",
        status: reader.status,
        deviceType: reader.device_type,
        location: reader.location,
        action: reader.action ? {
            type: reader.action.type,
            status: reader.action.status,
            failureMessage: reader.action.failure_message || null
        } : null,
        lastSeenAt: reader.last_seen_at || null
    };
}

async function readersStatus(env) {
    requireEnv(env, ["STRIPE_SECRET_KEY"]);
    const configured = configuredReaders(env);

    const readers = await Promise.all(configured.map(async (entry) => {
        try {
            return await fetchReaderStatus(env, entry);
        }
        catch (error) {
            return { id: entry.id, label: entry.label, status: "unavailable", error: error.publicMessage || error.message };
        }
    }));

    return json({ readers }, 200, { "Cache-Control": "no-store" });
}

// Takes the items and returns:
// { lineItemArray, subtotal }
async function readCartPrices(env, items, currency) {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CART_LINES) {
        const error = new Error(`Choose between 1 and ${MAX_CART_LINES} different products.`);
        error.status = 400;
        error.publicMessage = error.message;
        throw error;
    }

    const lineItems = [];
    let subtotal = 0;
    for (const item of items) {
        if (!item || typeof item.priceId !== "string" || !/^price_[A-Za-z0-9]+$/.test(item.priceId)) {
            const error = new Error("One of the selected products has an invalid price.");
            error.status = 400;
            error.publicMessage = error.message;
            throw error;
        }

        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
            const error = new Error(`Product quantities must be between 1 and ${MAX_QUANTITY}.`);
            error.status = 400;
            error.publicMessage = error.message;
            throw error;
        }

        const price = await stripe(env, `/v1/prices/${encodeURIComponent(item.priceId)}?expand[]=product`);
        if (!price.active || price.type === "recurring" || price.unit_amount == null || price.currency !== currency) {
            const error = new Error("A selected product is unavailable or has an unsupported price.");
            error.status = 400;
            error.publicMessage = error.message;
            throw error;
        }

        const product = typeof price.product === "object" ? price.product : null;
        if (!product || !product.active) {
            const error = new Error("A selected product is no longer available.");
            error.status = 400;
            error.publicMessage = error.message;
            throw error;
        }

        const unitAmount = Number(price.unit_amount);
        const lineAmount = unitAmount * quantity;
        if (!Number.isSafeInteger(lineAmount)) {
            const error = new Error("The cart total is too large.");
            error.status = 400;
            error.publicMessage = error.message;
            throw error;
        }

        subtotal += lineAmount;
        lineItems.push({
            productId: product.id,
            priceId: price.id,
            name: product.name,
            quantity,
            unitAmount,
            amount: lineAmount,
            taxBehavior: price.tax_behavior || null
        });
    }

    if (!Number.isSafeInteger(subtotal) || subtotal <= 0) {
        const error = new Error("The cart total is invalid.");
        error.status = 400;
        error.publicMessage = error.message;
        throw error;
    }

    return { lineItems, subtotal };
}

function taxIsEnabled(env) {
    return String(env.POS_TAX_ENABLED || "false").toLowerCase() === "true";
}

function taxAddress(env) {
    if (!env.POS_TAX_ADDRESS) {
        const error = new Error("POS_TAX_ADDRESS is required when POS_TAX_ENABLED is true.");
        error.status = 503;
        error.publicMessage = "Stripe Tax is enabled, but POS_TAX_ADDRESS is missing. Configure the physical point-of-sale address in Cloudflare Worker variables.";
        throw error;
    }

    let address;
    try {
        address = JSON.parse(env.POS_TAX_ADDRESS);
    } catch {
        const error = new Error("POS_TAX_ADDRESS must be valid JSON.");
        error.status = 503;
        error.publicMessage = "POS_TAX_ADDRESS must be valid JSON. Check the Cloudflare Worker variable.";
        throw error;
    }

    const required = ["line1", "city", "postal_code", "country"];
    if (!address || typeof address !== "object" || required.some((key) => typeof address[key] !== "string" || !address[key].trim())) {
        const error = new Error("POS_TAX_ADDRESS is incomplete.");
        error.status = 503;
        error.publicMessage = "POS_TAX_ADDRESS must include line1, city, postal_code, and country. Add state for provinces/regions where applicable.";
        throw error;
    }

    const country = address.country.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
        const error = new Error("POS_TAX_ADDRESS country must be a two-letter ISO country code.");
        error.status = 503;
        error.publicMessage = error.message;
        throw error;
    }

    return {
        line1: address.line1.trim(),
        ...(address.line2 ? { line2: String(address.line2).trim() } : {}),
        city: address.city.trim(),
        ...(address.state ? { state: String(address.state).trim().toUpperCase() } : {}),
        postal_code: address.postal_code.trim().toUpperCase(),
        country
    };
}

async function calculateTax(env, cart) {
    const address = taxAddress(env);
    const currency = (env.POS_CURRENCY || "cad").toLowerCase();

    const params = new URLSearchParams();
    params.set("currency", currency);
    params.set("customer_details[address_source]", env.POS_TAX_ADDRESS_SOURCE === "billing" ? "billing" : "shipping");

    for (const [key, value] of Object.entries(address)) {
        params.set(`customer_details[address][${key}]`, value);
    }

    let defaultTaxBehavior = null;

    if (cart.lineItems.some((item) => !item.taxBehavior || item.taxBehavior === "unspecified")) {
    const settings = await stripe(env, "/v1/tax/settings");
    defaultTaxBehavior = settings.defaults?.tax_behavior || "exclusive";

    if (defaultTaxBehavior === "inferred_by_currency") {
        const error = new Error("Stripe Tax uses inferred-by-currency pricing, which this POS does not infer automatically.");
        error.status = 400;
        error.publicMessage = "Set an explicit inclusive or exclusive tax behavior on each Stripe Price, or choose an explicit inclusive/exclusive default in Stripe Tax settings.";
        throw error;
    }

    if (defaultTaxBehavior !== "inclusive" && defaultTaxBehavior !== "exclusive") {
            defaultTaxBehavior = "exclusive";
        }
    }

    cart.lineItems.forEach((item, index) => {
        params.set(`line_items[${index}][amount]`, String(item.amount));
        params.set(`line_items[${index}][quantity]`, String(item.quantity));
        params.set(`line_items[${index}][product]`, item.productId);
        params.set(`line_items[${index}][reference]`, item.priceId);
        const taxBehavior = item.taxBehavior && item.taxBehavior !== "unspecified" ? item.taxBehavior : defaultTaxBehavior || "exclusive";
        params.set(`line_items[${index}][tax_behavior]`, taxBehavior);
    });

    params.append("expand[]", "line_items");

    const calculation = await stripe(env, "/v1/tax/calculations", { method: "POST", body: params });

    if (!Number.isSafeInteger(Number(calculation.amount_total))) {
        const error = new Error("Stripe Tax did not return a valid total.");
        error.status = 502;
        error.publicMessage = "Stripe Tax returned an invalid calculation. No payment was started.";
        throw error;
    }

    const lineTaxes = new Map((calculation.line_items?.data || []).map((line) => [line.reference, Number(line.amount_tax || 0)]));

    return {
        id: calculation.id,
        subtotal: cart.subtotal,
        taxAmount: Number(calculation.tax_amount_exclusive || 0) + Number(calculation.tax_amount_inclusive || 0),
        amountTotal: Number(calculation.amount_total),
        taxAmountExclusive: Number(calculation.tax_amount_exclusive || 0),
        taxAmountInclusive: Number(calculation.tax_amount_inclusive || 0),
        lineTaxes,
        breakdown: (calculation.tax_breakdown || []).map((entry) => ({
            amount: Number(entry.amount || 0),
            inclusive: Boolean(entry.inclusive),
            reason: entry.taxability_reason || null,
            percentage: entry.tax_rate_details?.percentage_decimal || null,
            taxType: entry.tax_rate_details?.tax_type || null
        }))
    };
}

async function taxPreview(request, env) {
    requireEnv(env, ["STRIPE_SECRET_KEY"]);
    if (!taxIsEnabled(env)) {
        return json({ taxEnabled: false }, 200, { "Cache-Control": "no-store" });
    }

    const body = await readJson(request);
    const currency = (env.POS_CURRENCY || "cad").toLowerCase();
    const cart = await readCartPrices(env, body.items, currency);
    const tax = await calculateTax(env, cart);

    return json({
        taxEnabled: true,
        currency,
        subtotal: tax.subtotal,
        taxAmount: tax.taxAmount,
        taxAmountExclusive: tax.taxAmountExclusive,
        taxAmountInclusive: tax.taxAmountInclusive,
        amountTotal: tax.amountTotal,
        breakdown: tax.breakdown
    }, 200, { "Cache-Control": "no-store" });
}

async function startCheckout(request, env) {
    requireEnv(env, ["STRIPE_SECRET_KEY"]);
    const body = await readJson(request);
    const selectedReader = configuredReader(env, body.readerId);
    const requestKey = request.headers.get("Idempotency-Key");

    if (!requestKey || requestKey.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(requestKey)) {
        return json({ error: "Missing or invalid checkout request ID. Please try again." }, 400);
    }

    const readerStatus = await fetchReaderStatus(env, selectedReader);
    if (readerStatus.status !== "online") {
        return json({ error: `${selectedReader.label} is ${readerStatus.status}. Choose an online reader before starting checkout.` }, 409);
    }
    if (readerStatus.action?.status === "in_progress") {
        return json({ error: `${selectedReader.label} is already processing another payment.` }, 409);
    }

    const currency = (env.POS_CURRENCY || "cad").toLowerCase();
    const cart = await readCartPrices(env, body.items, currency);
    let amount = cart.subtotal;
    let tax = null;
    if (taxIsEnabled(env)) {
        tax = await calculateTax(env, cart);
        amount = tax.amountTotal;
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        return json({ error: "The cart total is invalid." }, 400);
    }

    const orderId = crypto.randomUUID();
    const compactItems = JSON.stringify(cart.lineItems.map((item) => ({
        productId: item.productId,
        priceId: item.priceId,
        name: item.name,
        quantity: item.quantity,
        unitAmount: item.unitAmount
    })));

    if (compactItems.length > 500) {
        return json({ error: "This cart is too detailed to fit in Stripe payment metadata. Please split it into two payments." }, 400);
    }

    const intentParams = new URLSearchParams();
    intentParams.set("amount", String(amount));
    intentParams.set("currency", currency);
    intentParams.append("payment_method_types[]", "card_present");
    // Interac is supported for Terminal payments in Canada. Stripe will offer eligible methods on the reader.
    intentParams.append("payment_method_types[]", "interac_present");
    intentParams.set("capture_method", "automatic");
    intentParams.set("description", `Yukonstruct POS order ${orderId.slice(0, 8)}`);
    intentParams.set("metadata[order_id]", orderId);
    intentParams.set("metadata[order_items]", compactItems);
    intentParams.set("metadata[pos_source]", "yukonstruct_cloudflare_pos");
    intentParams.set("metadata[pos_reader_id]", selectedReader.id);
    intentParams.set("metadata[pos_subtotal]", String(cart.subtotal));

    if (tax) {
        intentParams.set("metadata[pos_tax_calculation_id]", tax.id);
        intentParams.set("metadata[pos_tax_amount]", String(tax.taxAmount));
        intentParams.set("metadata[pos_tax_status]", "pending");
    }

    const intent = await stripe(env, "/v1/payment_intents", {
        method: "POST",
        body: intentParams,
        idempotencyKey: `pos-${requestKey}`
    });

    const processParams = new URLSearchParams({ payment_intent: intent.id, "process_config[enable_customer_cancellation]": "true" });
    try {
        const reader = await stripe(env, `/v1/terminal/readers/${encodeURIComponent(selectedReader.id)}/process_payment_intent`, {
            method: "POST",
            body: processParams,
            idempotencyKey: `reader-${requestKey}`
        });

        return json({
            orderId,
            paymentIntentId: intent.id,
            amount,
            subtotal: cart.subtotal,
            taxAmount: tax?.taxAmount || 0,
            taxAmountExclusive: tax?.taxAmountExclusive || 0,
            taxAmountInclusive: tax?.taxAmountInclusive || 0,
            taxEnabled: Boolean(tax),
            currency,
            readerId: selectedReader.id,
            readerLabel: selectedReader.label,
            readerActionStatus: reader.action?.status || "in_progress",
            items: cart.lineItems.map(({ name, quantity, unitAmount }) => ({ name, quantity, unitAmount }))
        }, 200, { "Cache-Control": "no-store" });
    } catch (error) {

    // Do not blindly cancel the PaymentIntent: a network timeout can occur after Stripe has
    // accepted the reader command. The operator should check the reader/payment status first.
    error.publicMessage = "Stripe created payment " + intent.id + ", but did not confirm the reader command. Check the terminal and payment status before trying again. " + (error.publicMessage || error.message);
    error.status = 502;
    throw error;
    }
}

async function recordTaxTransaction(env, intent) {
    const calculationId = intent.metadata?.pos_tax_calculation_id;
    if (!calculationId) {
        return { status: "not_required" };
    }

    if (intent.metadata?.pos_tax_transaction_id) {
        return { status: "recorded", transactionId: intent.metadata.pos_tax_transaction_id };
    }

    try {
        const orderId = intent.metadata?.order_id;

        if (!orderId) {
            throw new Error("PaymentIntent is missing its POS order reference.");
        }

        const params = new URLSearchParams({ calculation: calculationId, reference: orderId });
        params.set("metadata[pos_source]", "yukonstruct_cloudflare_pos");
        params.set("metadata[payment_intent_id]", intent.id);
        const transaction = await stripe(env, "/v1/tax/transactions/create_from_calculation", {
            method: "POST", body: params, idempotencyKey: `tax-${orderId}`
        });

        await stripe(env, `/v1/payment_intents/${encodeURIComponent(intent.id)}`, {
            method: "POST",
            body: new URLSearchParams({
            "metadata[pos_tax_transaction_id]": transaction.id,
            "metadata[pos_tax_status]": "recorded"
            }),
            idempotencyKey: `tax-meta-${orderId}`
        });

        return {
            status: "recorded",
            transactionId: transaction.id
        };
    } catch (error) {
        console.error("Stripe Tax transaction recording failed:", error?.message || error);
        return {
            status: "failed",
            message: error.publicMessage || error.message || "Stripe Tax transaction recording failed."
        };
    }
}

async function stripeWebhook(request, env) {
    requireEnv(env, ["STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY"]);
    const rawBody = await request.text();
    const signature = request.headers.get("Stripe-Signature") || "";
    const parts = signature.split(",").map((part) => part.split("=", 2));
    const timestamp = parts.find(([key]) => key === "t")?.[1];
    const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
    const timestampNumber = Number(timestamp);

    if (!Number.isInteger(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300 || !signatures.length) {
        return json({ error: "Invalid Stripe webhook signature." }, 400);
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload)));
    const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    if (!signatures.some((candidate) => constantTimeEqual(candidate, expected))) {
        return json({ error: "Invalid Stripe webhook signature." }, 400);
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return json({ error: "Invalid webhook payload." }, 400);
    }

    if (event.type === "payment_intent.succeeded") {
        const intent = event.data?.object;

        if (intent?.metadata?.pos_tax_calculation_id) {
            const result = await recordTaxTransaction(env, intent);
            if (result.status !== "recorded") {
                return json({ error: result.message || "Unable to record Stripe Tax transaction." }, 500);
            }
        }
    }
    return json({ received: true });
}

async function paymentStatus(env, paymentIntentId) {
    requireEnv(env, ["STRIPE_SECRET_KEY"]);
    let intent = await stripe(env, `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`);
    const taxRecord = intent.status === "succeeded" ? await recordTaxTransaction(env, intent) : { status: intent.metadata?.pos_tax_status || "not_ready" };

    if (intent.status === "succeeded" && taxRecord.status === "recorded" && !intent.metadata?.pos_tax_transaction_id) {
        intent = await stripe(env, `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`);
    }

    const readerConfig = configuredReader(env, intent.metadata?.pos_reader_id);
    const reader = await stripe(env, `/v1/terminal/readers/${encodeURIComponent(readerConfig.id)}`);
    const action = reader.action || null;
    const actionMatches = action?.type === "process_payment_intent" && action?.process_payment_intent?.payment_intent === paymentIntentId;
    let state = intent.status;

    if (intent.status === "succeeded") state = "succeeded";
    else if (intent.status === "canceled") state = "canceled";
    else if (actionMatches && action.status === "failed") state = "failed";
    else if (actionMatches && action.status === "in_progress") state = "in_progress";
    else if (intent.status === "requires_payment_method" || intent.status === "requires_confirmation" || intent.status === "processing") state = "in_progress";

    return json({
        paymentIntentId,
        readerId: readerConfig.id,
        readerLabel: readerConfig.label,
        state,
        paymentIntentStatus: intent.status,
        readerActionStatus: actionMatches ? action.status : null,
        failureMessage: actionMatches ? action.failure_message || null : null,
        amount: intent.amount,
        subtotal: Number(intent.metadata?.pos_subtotal || intent.amount),
        taxAmount: Number(intent.metadata?.pos_tax_amount || 0),
        taxRecordStatus: taxRecord.status,
        taxRecordMessage: taxRecord.message || null,
        currency: intent.currency,
        readerStatus: reader.status
        }, 200, { "Cache-Control": "no-store" });
}

async function retryPayment(request, env) {
    requireEnv(env, ["STRIPE_SECRET_KEY"]);
    const body = await readJson(request);

    if (typeof body.paymentIntentId !== "string" || !/^pi_[A-Za-z0-9]+$/.test(body.paymentIntentId)) {
        return json({ error: "Invalid payment reference." }, 400);
    }

    const intent = await stripe(env, `/v1/payment_intents/${encodeURIComponent(body.paymentIntentId)}`);
    const readerConfig = configuredReader(env, intent.metadata?.pos_reader_id);
    const reader = await stripe(env, `/v1/terminal/readers/${encodeURIComponent(readerConfig.id)}`);

    if (intent.status !== "requires_payment_method") {
        return json({ error: "This payment cannot be retried. Check its status before starting another sale." }, 409);
    }

    if (reader.action?.status === "in_progress") {
        return json({ error: "The reader is already processing a payment." }, 409);
    }

    const result = await stripe(env, `/v1/terminal/readers/${encodeURIComponent(readerConfig.id)}/process_payment_intent`, {
        method: "POST",
        body: new URLSearchParams({ payment_intent: body.paymentIntentId, "process_config[enable_customer_cancellation]": "true" }),
        idempotencyKey: `retry-${crypto.randomUUID()}`
    });

    return json({
        ok: true,
        readerActionStatus: result.action?.status || "in_progress",
        readerLabel: readerConfig.label
    }, 200, { "Cache-Control": "no-store" });
}

async function cancelPayment(request, env) {
    requireEnv(env, ["STRIPE_SECRET_KEY"]);
    const body = await readJson(request);

    if (typeof body.paymentIntentId !== "string" || !/^pi_[A-Za-z0-9]+$/.test(body.paymentIntentId)) {
        return json({ error: "Invalid payment reference." }, 400);
    }

    const intentBefore = await stripe(env, `/v1/payment_intents/${encodeURIComponent(body.paymentIntentId)}`);
    const readerConfig = configuredReader(env, intentBefore.metadata?.pos_reader_id);
    const reader = await stripe(env, `/v1/terminal/readers/${encodeURIComponent(readerConfig.id)}`);
    const action = reader.action;
    const actionPi = action?.process_payment_intent?.payment_intent;

    if (action?.type !== "process_payment_intent" || actionPi !== body.paymentIntentId || action.status !== "in_progress") {
        return json({ error: "There is no matching in-progress payment to cancel. Check the payment status." }, 409);
    }

    const result = await stripe(env, `/v1/terminal/readers/${encodeURIComponent(readerConfig.id)}/cancel_action`, {
        method: "POST",
        body: new URLSearchParams()
    });

    const intent = await stripe(env, `/v1/payment_intents/${encodeURIComponent(body.paymentIntentId)}`);

    if (intent.status === "requires_payment_method") {
        await stripe(env, `/v1/payment_intents/${encodeURIComponent(body.paymentIntentId)}/cancel`, {
            method: "POST", body: new URLSearchParams()
        });
    }

    return json({ ok: true, actionStatus: result.action?.status || "canceled" }, 200, { "Cache-Control": "no-store" });
}

async function stripe(env, path, options = {}) {
    const headers = new Headers({ Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` });
    let body;

    if (options.body) {
        headers.set("Content-Type", "application/x-www-form-urlencoded");
        body = options.body.toString();
    }

    if (options.idempotencyKey) {
        headers.set("Idempotency-Key", options.idempotencyKey);
    }

    const response = await fetch(`https://api.stripe.com${path}`, {
        method: options.method || "GET",
        headers,
        body
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message = data?.error?.message || `Stripe returned HTTP ${response.status}.`;
        const error = new Error(message);
        error.publicMessage = message;
        error.status = response.status >= 500 ? 502 : 400;
        throw error;
    }

    return data;
}

async function isAuthenticated(request, env) {
    if (!env.SESSION_SECRET) {
        return false;
    }

    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    if (!match) {
        return false;
    }

    const parts = match[1].split(".");
    if (parts.length !== 3) {
        return false;
    }

    const [expiryText, nonce, signature] = parts;
    const expiry = Number(expiryText);
    if (!Number.isInteger(expiry) || expiry < Math.floor(Date.now() / 1000) || !nonce || !signature) {
        return false;
    }

    const expected = await hmac(`${expiryText}.${nonce}`, env.SESSION_SECRET);

    return constantTimeEqual(signature, expected);
}

async function hmac(value, secret) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return toBase64Url(new Uint8Array(signature));
}

function toBase64Url(bytes) {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") {
        return false;
    }

    const encoder = new TextEncoder();
    const aa = encoder.encode(a);
    const bb = encoder.encode(b);
    let diff = aa.length ^ bb.length;
    const length = Math.max(aa.length, bb.length);

    for (let i = 0; i < length; i++) {
        diff |= (aa[i % (aa.length || 1)] || 0) ^ (bb[i % (bb.length || 1)] || 0);
    }

    return diff === 0;
}

function assertSameOrigin(request, url) {
    const origin = request.headers.get("Origin");
    if (!origin || origin !== url.origin) {
        const error = new Error("Cross-origin request rejected.");
        error.status = 403;
        error.publicMessage = "This request did not come from the POS site.";
        throw error;
    }
}

async function readJson(request) {
    if (!request.headers.get("Content-Type")?.includes("application/json")) {
        const error = new Error("Expected JSON request body.");
        error.status = 415;
        error.publicMessage = "Invalid request format.";
        throw error;
    }

    try {
        return await request.json();
    } catch {
        const error = new Error("Invalid JSON.");
        error.status = 400;
        error.publicMessage = "The request was not valid JSON.";
        throw error;
    }
}

function requireEnv(env, names) {
    const missing = names.filter((name) => !env[name]);
    if (missing.length) {
        const error = new Error(`Missing configuration: ${missing.join(", ")}`);
        error.status = 503;
        error.publicMessage = `The POS is not configured yet. Missing: ${missing.join(", ")}.`;
        throw error;
    }
}

function json(data, status = 200, extraHeaders = {}) {
    const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...extraHeaders
    });

    return new Response(JSON.stringify(data), { status, headers });
}
