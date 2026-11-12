import { execa } from "execa";
import { execFileSync } from "node:child_process";

const webhookPath = "/api/webhook";
const localUrl = "http://localhost:8787";
const isWin = process.platform === "win32";

async function main() {
    let stripe;
    let wrangler;
    let shuttingDown = false;

    async function shutdown(reason) {
        if (shuttingDown) return;
        shuttingDown = true;

        console.log(`\nShutting down (${reason})...`);

        const killChild = async (child, name) => {
            if (!child || child.killed) return;

            if (isWin) {
                try {
                    // /T = process tree, /F = force
                    execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                        stdio: "ignore",
                    });
                } catch { }
            } else {
                child.kill("SIGTERM");
            }
        };

        await Promise.all([
            killChild(stripe, "stripe"),
            killChild(wrangler, "wrangler"),
        ]);
        
        process.exit(0); // force clean exit
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // ---- Stripe CLI -------------------------------------------------
    stripe = execa(
        "stripe",
        [
            "listen",
            "--forward-to",
            `${localUrl}${webhookPath}`,
            "--events",
            "terminal.reader.action_succeeded,terminal.reader.action_failed",
        ],
        {
            preferLocal: true,
            stdout: ["inherit", "pipe"],
            stderr: ["inherit", "pipe"],
            cleanup: true,
        }
    );

    let secret = "";

    await new Promise((resolve, reject) => {
        const handleOutput = (data) => {
            const output = data.toString();

            const match = output.match(/whsec_[a-zA-Z0-9]+/);
            if (match) {
                secret = match[0];
                // stop listening once we have the secret
                stripe.stdout.off("data", handleOutput);
                stripe.stderr.off("data", handleOutput);
                resolve();
            }
        };

        stripe.stdout.on("data", handleOutput);
        stripe.stderr.on("data", handleOutput);

        stripe.catch((err) => {
            if (!secret) reject(err);
        });
    });

    console.log("Found webhook secret. Launching Wrangler...");

    // ---- Wrangler ---------------------------------------------------
    wrangler = execa(
        process.execPath,
        [
            "./node_modules/wrangler/bin/wrangler.js",
            "dev",
            "--var",
            `STRIPE_WEBHOOK_SECRET:${secret}`
        ],
        {
            stdio: ["ignore", "inherit", "inherit"],
            cleanup: true
        }
    );

    // Keep the process alive until we explicitly shut down
    await new Promise(() => { });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});