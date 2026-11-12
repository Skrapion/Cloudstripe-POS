# Cloudstripe POS

A point-of-sale for Stripe terminals that runs for free on Cloudflare Workers.

For some reason, Stripe doesn't offer a basic POS to use with their fancy terminals, forcing you to use third-party POS apps that take a percentage. This fixes that.

This is a "serverless" app meant to be installed on Cloudflare Workers. Cloudflare offers 100,000 free executions per day. Every sale takes a handful of executions.

## Requirements

- Cloudflare account.
- Node.js and npm on whatever computer you use to manage your Cloudflare account.
- Stripe account with Terminal registered and products added to the product catalog.
- A Stripe secret API key.
- A Stripe [webhook](#webhooks) subscribed to the necessary events.

It's recommended to set up Stripe in Sandbox mode first to test the app.

## Test locally

```bash
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your settings. See [Variables](#variables) for more details. Then:

```bash
npx stripe login
```

Follow the instructions to log into Stripe. It's recommended to use a sandbox account when testing.

Finally:

```bash
npm run dev
```

Open the local URL printed by Wrangler and sign in with `POS_PASSWORD`.

## Presenting test cards
While running Cloudstripe locally, you can open another command line and run:

```bash
npx stripe post v1/test_helpers/terminal/readers/<terminal_id>/present_payment_method -d "type=card_present" -d "card_present[number]=4242424242424242"
```

Try it with a few of [Stripe's other test card numbers](https://docs.stripe.com/terminal/references/testing).

## Deploy to Cloudflare Workers

```bash
npx wrangler login
npm run deploy
```

After deploying, you'll find your working in the Cloudflare dashboard under **Build->Computer->Workers & Pages**.

Then configure the Worker variables and secrets in Cloudflare as described in [Variables](#variables).

Cloudflare will provide a domain name for you in the form of https://cloudstripe-pos.\<your id\>.workers.dev. You can create a custom domain if Cloudflare is your DNS.

## Webhooks

Cloudstripe needs webhooks registered to reveice feedback from Stripe.

When testing locally, you don't need to set `STRIPE_WEBHOOK_SECRET`. Instread, you run `npx stripe login` to log into the Stripe CLI, and then when you run `npm run dev` Cloudstripe will automatically run the Stripe CLI in the background to create a temprary webhook for you.

When you deploy to Cloudflare, you'll need to create a proper webhook.

In the Stripe Dashboard, create a new Destination in **Workbench->Webooks**. Select the following event types:

- `terminal.reader.action_succeeded`
- `terminal.reader.action_failed`

Finally, set the `Endpoint URL` to `https://\<your-worker-hostname\>/api/webhook`

Stripe will give you a secret for your new endpoint in the form of `whsec_...`. Copy that secret to `STRIPE_WEBHOOK_SECRET`.

## Collecting Tax

In Stripe Dashboard, enable Stripe Tax and confirm that you have an active tax registration covering the address listed in `POS_TAX_ADDRESS_SOURCE`.

Set the tax behavior on each Stripe Price (`exclusive` or `inclusive`), or configure an explicit `exclusive`/`inclusive` default tax behavior in Stripe Tax settings.

When you're ready, set `POS_TAX_ENABLED` to `true`.

## Variables
Variables can be set in .dev.vars when running locally with npm, or in the Cloudflare environment variables found in **Settings → Variables and Secrets**.

| Variable Name | Example | Secret | Description |
| ------------- | ------- | ------ | ----------- |
| `STRIPE_SECRET_KEY` | `sk_test_...` | :white_check_mark: | Your Stripe API secret key (`sk_test_...`).<br>This can be created in the Stripe Dashboard in **Settings->Developers->API Keys**.<br>Create a restricted key, then choose "Powering an integration you built" and "In-person payments with Terminal". |
| `STRIPE_WEBHOOK_SECRET` | `whsec_REPLACE_ME` | :white_check_mark: | This allows Stripe to call into Cloudstripe for transaction updates. This is handled automatically when running locally. See [Webhooks](#webhooks) |
|`POS_PASSWORD` | `my-very-secure-login-password` | :white_check_mark: | The password that the staff will use to log into the POS. |
| `SESSION_SECRET` | `Yfw3qqF...` | :white_check_mark: | A random string of at least 32 characters.<br>This allows the client to communicate securely with your Cloudflare worker. |
| `POS_READERS` | `[<br>  {"id": "tmr_REPLACE_ME_1", "label": "Front Desk"},<br>  {"id": "tmr_REPLACE_ME_2", "label": "Back Office"}<br>]` | | A list of all your Stripe terminals. The ID is found in **Payments->Terminal->Readers->\<Reader Name\>**. The label is how you want it to appear in the POS. |
| `POS_CURRENCY` | `cad` | | Your local currency, eg cad, usd, eur |
| `POS_TAX_ENABLED` | `true` | | Set to true in order to collect tax. You'll need to set up taxation properly on your products in the Stripe Dashboard. |
| `POS_TAX_ADDRESS` | `{<br>  "line1": "123 Avenue Rd.",<br>  "city": "Toronto",<br>  "state": "ON",<br>  "postal_code": "A1B 2C3",<br>  "country": "CA"<br>}` | | The address of your store, used to pull the correct tax rate from Stripe.<br>This is technically supposed to be the customer's address, but Cloudstripe doesn't collect customer addresses, so your store address is used as the shipping address. |
| `POS_TAX_ADDRESS_SOURCE` | `shipping` | | This can be `billing` or `shipping` to signify whether the address above is the customer's billing address or their shipping address. Assuming you're using your store's address, `shipping` is the better choice. |

## Securing the installation
Congratulations! You have your own POS installed and working!

Currently, your POS is only secured by a password shared by your staff. Since this is located on a publicly accessible Cloudflare worker, theoretically anybody can access it if they have (or guess) your password.

Cloudstripe POS can only wake up your terminals and collect money to your Stripe account, so the only thing attackers can do is cause a nuisance.

Once your POS is working well, it is recommended to set up Cloudflare Zero Trust and run the app through the Cloudflare One Agent/Client in order to lock down the application to your specific devices.
