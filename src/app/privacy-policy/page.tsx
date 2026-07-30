import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy policy for the Olympic Equipment Customer Service app.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-8">
      <h1 className="text-3xl">Privacy Policy</h1>
      <p className="mt-3 text-sm text-neutral-700">
        Last updated: July 30, 2026
      </p>

      <section className="card mt-6 space-y-4 p-6">
        <p>
          This Privacy Policy explains how Olympic Equipment handles information in the
          Customer Service Tracking application (&quot;Application&quot;).
        </p>

        <h2 className="text-xl">1. Information Collected</h2>
        <p>
          The Application stores business data needed to manage customer service operations,
          including customer account details, case notes, activity records, and attachments.
        </p>

        <h2 className="text-xl">2. How Information Is Used</h2>
        <p>
          Information is used to create, manage, and resolve customer service cases, support
          internal reporting, and maintain operational history.
        </p>

        <h2 className="text-xl">3. Data Sources</h2>
        <p>
          Data may be entered by staff and may include synchronized records from connected
          business systems such as QuickBooks when configured.
        </p>

        <h2 className="text-xl">4. Data Sharing</h2>
        <p>
          Information is used for internal operations and is not sold. Access is limited to
          authorized personnel and service providers supporting the Application.
        </p>

        <h2 className="text-xl">5. Security</h2>
        <p>
          Olympic Equipment applies administrative and technical safeguards to protect
          Application data. No method of storage or transmission is completely secure.
        </p>

        <h2 className="text-xl">6. Data Retention</h2>
        <p>
          Records are retained according to operational, legal, and compliance needs and may be
          deleted or archived under internal policies.
        </p>

        <h2 className="text-xl">7. Your Choices</h2>
        <p>
          Authorized users can request updates or corrections to relevant records through
          internal support channels.
        </p>

        <h2 className="text-xl">8. Policy Updates</h2>
        <p>
          This policy may be updated from time to time. The &quot;Last updated&quot; date reflects the
          latest revision.
        </p>

        <h2 className="text-xl">9. Contact</h2>
        <p>
          For privacy questions, contact Olympic Equipment system administration.
        </p>
      </section>
    </main>
  );
}
