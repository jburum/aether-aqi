import { createFileRoute } from "@tanstack/react-router";

import { AIRHAPPY, AirHappyPage, List, MailLink, Section } from "@/components/airhappy-page";

const PRIVACY_UPDATED = "November 2, 2026";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy · AirHappy" },
      {
        name: "description",
        content:
          "What AirHappy keeps, what it sends, and what it never does: no ads, no tracking, no selling your data.",
      },
    ],
  }),
  component: Privacy,
});

function Privacy() {
  return (
    <AirHappyPage title="Privacy Policy" updated={PRIVACY_UPDATED}>
      <p>
        This policy covers the {AIRHAPPY.name} iPhone app and the airhappy.app website. Both are
        published by {AIRHAPPY.publisher} (“we”, “us”). {AIRHAPPY.name} needs to know which places
        you care about so it can forecast the air there. Beyond that, we keep as little as possible.
      </p>

      <Section title="The short version">
        <List>
          <li>
            No ads, no advertising or analytics SDKs, and no tracking across other apps or websites.
          </li>
          <li>We don’t sell or rent your data, and we don’t share it for advertising.</li>
          <li>
            Your saved places and alert choices are kept on your phone unless a feature needs our
            server.
          </li>
          <li>
            Location is optional, used only while the app is open, and only when you ask for it.
          </li>
          <li>Apple handles payment. We never see your card or bank details.</li>
        </List>
      </Section>

      <Section title="What stays on your phone">
        <p>
          Your saved places (name and map coordinates), their order, and which alerts you turned on
          are stored on your device. Deleting the app deletes them.
        </p>
      </Section>

      <Section title="What our server receives">
        <List>
          <li>
            <strong>Places you forecast.</strong> To build a forecast, the app sends a place’s
            coordinates to our server. If a feature keeps your places on our server (for example, so
            alerts can be checked while the app is closed), we store each place’s name, coordinates,
            alert setting, and the forecasts made for it, linked to your account.
          </li>
          <li>
            <strong>Pro subscription status.</strong> When you subscribe, Apple gives the app a
            signed record of the purchase. We keep which plan you chose (monthly or yearly), when it
            renews or ends, and whether it is active, so Pro features work. We don’t receive your
            name, email, or payment details from Apple.
          </li>
          <li>
            <strong>Notifications.</strong> If you turn on alerts and allow notifications, we keep
            the push token Apple gives your device so we can deliver the alert, and a record of
            which alerts were sent so you don’t get the same one twice.
          </li>
          <li>
            <strong>Sign-in, if you use it.</strong> If you sign in, we receive the name, email
            address, and profile picture your sign-in provider shares, and keep a session so you
            stay signed in.
          </li>
          <li>
            <strong>Server logs.</strong> Our hosting provider records technical details of each
            request (IP address, time, the page or data requested, browser or app version) to keep
            the service running and secure. These logs are not used to build a profile of you.
          </li>
        </List>
      </Section>

      <Section title="Location">
        <p>
          You can always add a place by searching or picking it from a list. If you choose to use
          your current location, {AIRHAPPY.name} asks for permission “while using the app” only. It
          reads your position once, uses it to name the spot and fetch its forecast, and does not
          keep a history of where you have been. You can turn location off any time in Settings →
          Privacy &amp; Security → Location Services.
        </p>
      </Section>

      <Section title="Who else is involved">
        <p>
          We use a few service providers to run {AIRHAPPY.name}. They process data only to provide
          their service to us.
        </p>
        <List>
          <li>
            <strong>Apple</strong>: App Store purchases, subscriptions, refunds, and push
            notifications.
          </li>
          <li>
            <strong>Vercel</strong> (hosting) and <strong>Neon</strong> (database): run our server
            and store the data described above, in the United States.
          </li>
          <li>
            <strong>Public air and weather data sources</strong>: NOAA, the U.S. EPA AirNow program,
            and Open-Meteo. Our server sends them the coordinates of a place to get its forecast or
            latest reading. They don’t receive your name, email, or account ID.
          </li>
          <li>
            <strong>Place search on the website</strong>: place names you type are sent to
            Open-Meteo’s geocoding service. If you use “current location” on the website, your
            coordinates are sent to BigDataCloud to look up the nearest town name, and to Open-Meteo
            for the air reading.
          </li>
        </List>
        <p>
          We may disclose information if the law requires it, or to protect the safety of our users
          or the service. If {AIRHAPPY.publisher} or {AIRHAPPY.name} is sold or merged, this policy
          continues to apply to data collected under it.
        </p>
      </Section>

      <Section title="The website">
        <p>
          The airhappy.app website keeps your watchlist in your browser’s local storage, not on our
          server. Clearing your browser data removes it. The website uses no advertising or
          analytics cookies.
        </p>
      </Section>

      <Section title="How long we keep it">
        <List>
          <li>Places and their forecasts: until you delete the place or your account.</li>
          <li>Subscription status: while you have an account, so a renewal or restore works.</li>
          <li>
            Push tokens: until you turn alerts off, the token stops working, or you delete your
            account.
          </li>
          <li>Server logs: kept briefly by our hosting provider, then deleted.</li>
        </List>
      </Section>

      <Section title="Your choices and rights">
        <p>
          You can ask us for a copy of your data, to correct it, or to delete it. Email{" "}
          <MailLink subject="AirHappy data request" /> from any address, and tell us what you’d
          like. We’ll confirm the request and complete it within 30 days. Deleting your data does
          not cancel an App Store subscription; cancel that in Settings → your name → Subscriptions.
        </p>
        <p>
          Depending on where you live (for example, California or the European Union), you may have
          further rights under local law, including the right to complain to a data protection
          authority. We honor these requests wherever you live.
        </p>
      </Section>

      <Section title="Children">
        <p>
          {AIRHAPPY.name} is not directed to children under 13, and we don’t knowingly collect
          personal information from them. If you believe a child has given us personal information,
          email us and we will delete it.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Data is sent over encrypted connections (HTTPS) and stored with access limited to the
          people who run {AIRHAPPY.name}. No system is perfectly secure, but we keep what we hold
          small on purpose.
        </p>
      </Section>

      <Section title="Not medical advice">
        <p>
          {AIRHAPPY.name} forecasts air quality. It doesn’t give medical advice, and we don’t ask
          for or keep health information.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          If we change this policy, we will update the date at the top. If a change affects how we
          use data we already hold, we will tell you in the app before it takes effect.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          {AIRHAPPY.publisher}, publisher of {AIRHAPPY.name}. Email <MailLink />.
        </p>
      </Section>
    </AirHappyPage>
  );
}
