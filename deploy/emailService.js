// Sends verification emails via Azure Communication Services when configured; otherwise no-ops (dev falls back to console logging in server.js).
let emailClient = null;

function getEmailClient() {
  const connectionString = process.env.ACS_CONNECTION_STRING;
  if (!connectionString) {
    return null;
  }

  if (!emailClient) {
    // Lazy import so the dependency is only required when ACS is actually configured.
    emailClient = import('@azure/communication-email').then(
      ({ EmailClient }) => new EmailClient(connectionString),
    );
  }

  return emailClient;
}

async function sendVerificationEmail({ email, link }) {
  const clientPromise = getEmailClient();
  const senderAddress = process.env.ACS_SENDER_ADDRESS;

  if (!clientPromise || !senderAddress) {
    return false;
  }

  const client = await clientPromise;
  const poller = await client.beginSend({
    senderAddress,
    content: {
      subject: 'Verify your Guess Party email',
      plainText: `Verify your email to start hosting rooms: ${link}`,
      html: `<p>Verify your email to start hosting rooms:</p><p><a href="${link}">${link}</a></p>`,
    },
    recipients: { to: [{ address: email }] },
  });

  await poller.pollUntilDone();
  return true;
}

export { sendVerificationEmail };
