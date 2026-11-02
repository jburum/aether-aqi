import { createFileRoute } from "@tanstack/react-router";

import { AIRHAPPY, AirHappyPage, List, MailLink, Section } from "@/components/airhappy-page";

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: "Support · AirHappy" },
      {
        name: "description",
        content:
          "Help with AirHappy: where the air forecast comes from, Free and Pro, subscriptions, location, alerts, and how to reach us.",
      },
    ],
  }),
  component: Support,
});

function Support() {
  return (
    <AirHappyPage title="Support">
      <p>
        {AIRHAPPY.name} answers one question: <strong>{AIRHAPPY.question}</strong> It forecasts
        smoke and air quality hour by hour for the places you save, picks the cleanest window to be
        outside, and tells you when smoke, an inversion, or ozone is on the way.
      </p>

      <Section title="Contact us">
        <p>
          Email <MailLink subject="AirHappy support" />. We usually reply within two business days.
        </p>
        <p>To help us fix a problem quickly, please include:</p>
        <List>
          <li>Your iPhone model and iOS version (Settings → General → About).</li>
          <li>The {AIRHAPPY.name} version, if you know it.</li>
          <li>The place you were looking at, and what you expected to see.</li>
          <li>A screenshot, if you can.</li>
        </List>
        <p className="text-muted">
          Please don’t send health information. We can’t give medical advice.
        </p>
      </Section>

      <Section title="Where does the forecast come from?">
        <p>{AIRHAPPY.name} uses public data from U.S. agencies and corrects it for your valley:</p>
        <List>
          <li>
            <strong>Today and tomorrow:</strong> NOAA’s smoke model at valley scale, the most
            detailed forecast available for wildfire smoke.
          </li>
          <li>
            <strong>Days 3 to 7:</strong> NOAA’s air quality forecast, or a regional outlook marked
            as low confidence when that is all there is.
          </li>
          <li>
            <strong>Right now:</strong> the latest official reading from the U.S. EPA AirNow
            program, shown beside the forecast, credited to AirNow, and marked preliminary.
          </li>
        </List>
        <p>
          The forecast and the official reading are always shown as two separate numbers. They can
          differ: the forecast is for the hour ahead at your place, and the official reading is the
          last hour measured at the nearest monitor.
        </p>
      </Section>

      <Section title="Is it safe for me to go outside?">
        <p>
          {AIRHAPPY.name} shows the air forecast and the U.S. Air Quality Index category for each
          hour. It is <strong>not medical advice</strong>. Forecasts can be wrong, especially when a
          fire changes quickly. If you have asthma, heart or lung disease, are pregnant, or are
          caring for children or older adults, follow your doctor’s advice and local health alerts.
          In an emergency, call 911.
        </p>
      </Section>

      <Section title="Free and Pro">
        <List>
          <li>
            <strong>Free:</strong> one saved place, with current air, the 48-hour timeline, the best
            window to be outside, and the week’s outlook.
          </li>
          <li>
            <strong>Pro:</strong> up to five saved places, plus smoke, inversion, and ozone alerts.
            ${AIRHAPPY.monthlyUsd} a month or ${AIRHAPPY.yearlyUsd} a year (U.S. prices; Apple shows
            the price in your currency).
          </li>
        </List>
        <p>
          If Pro ends, your saved places stay. You keep full access to your first place, and the
          others open again when you renew.
        </p>
      </Section>

      <Section id="subscriptions" title="Manage or cancel your subscription">
        <p>
          Pro is an auto-renewing subscription billed by Apple through your Apple Account. It renews
          unless you turn it off at least 24 hours before the end of the current period.
        </p>
        <List>
          <li>
            <strong>Cancel or change plans:</strong> on your iPhone, open Settings → your name →
            Subscriptions → {AIRHAPPY.name}.
          </li>
          <li>
            <strong>Restore Pro on a new phone:</strong> open {AIRHAPPY.name}, go to Pro, and tap
            Restore purchases. Use the same Apple Account you subscribed with.
          </li>
          <li>
            <strong>Refunds:</strong> Apple handles refunds. Request one at{" "}
            <a
              className="font-medium text-fg underline underline-offset-4"
              href="https://reportaproblem.apple.com"
              rel="noopener noreferrer"
            >
              reportaproblem.apple.com
            </a>
            . We can’t issue refunds ourselves.
          </li>
        </List>
      </Section>

      <Section title="Location">
        <p>
          You can add a place by searching for it or picking from the list. You don’t have to share
          your location. If you choose to use your current location, {AIRHAPPY.name} asks for
          permission only while the app is open, and only uses it to find the air for that spot. You
          can change this any time in Settings → Privacy &amp; Security → Location Services →{" "}
          {AIRHAPPY.name}.
        </p>
      </Section>

      <Section title="Alerts">
        <p>
          Every alert is off until you turn it on. Alerts are part of Pro. To stop notifications,
          turn the alert off in the app, or go to Settings → Notifications → {AIRHAPPY.name}.
        </p>
      </Section>

      <Section title="Your data">
        <p>
          {AIRHAPPY.name} has no ads and no tracking. To ask for a copy of your data or have it
          deleted, email <MailLink subject="AirHappy data request" />. The{" "}
          <a className="font-medium text-fg underline underline-offset-4" href="/privacy">
            Privacy Policy
          </a>{" "}
          explains what is kept and why.
        </p>
      </Section>
    </AirHappyPage>
  );
}
