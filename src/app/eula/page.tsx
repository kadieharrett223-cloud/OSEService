import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "End-User License Agreement",
  description: "End-user license agreement for the Olympic Equipment Customer Service app.",
};

export default function EulaPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-8">
      <h1 className="text-3xl">End-User License Agreement</h1>
      <p className="mt-3 text-sm text-neutral-700">
        Last updated: July 30, 2026
      </p>

      <section className="card mt-6 space-y-4 p-6">
        <p>
          This End-User License Agreement (&quot;Agreement&quot;) governs use of the Olympic Equipment
          Customer Service Tracking application (&quot;Application&quot;). By using the Application,
          you agree to this Agreement.
        </p>

        <h2 className="text-xl">1. License Grant</h2>
        <p>
          Olympic Equipment grants authorized personnel a limited, non-exclusive,
          non-transferable, revocable license to use the Application for internal business
          operations.
        </p>

        <h2 className="text-xl">2. Authorized Use</h2>
        <p>
          You may access the Application only through approved credentials and shared access
          controls provided by Olympic Equipment. You must not share access outside your
          organization.
        </p>

        <h2 className="text-xl">3. Restrictions</h2>
        <p>
          You may not reverse engineer, decompile, copy, redistribute, or use the Application
          for unlawful or unauthorized purposes.
        </p>

        <h2 className="text-xl">4. Data and Confidentiality</h2>
        <p>
          Case, customer, and operational data in the Application may include confidential
          business information. You agree to handle all data under your organization&apos;s
          confidentiality and security requirements.
        </p>

        <h2 className="text-xl">5. Availability and Changes</h2>
        <p>
          Olympic Equipment may update, suspend, or discontinue the Application or any feature
          at any time, with or without notice.
        </p>

        <h2 className="text-xl">6. Disclaimer</h2>
        <p>
          The Application is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind,
          to the fullest extent permitted by law.
        </p>

        <h2 className="text-xl">7. Limitation of Liability</h2>
        <p>
          To the fullest extent permitted by law, Olympic Equipment is not liable for indirect,
          incidental, special, or consequential damages arising from use of the Application.
        </p>

        <h2 className="text-xl">8. Termination</h2>
        <p>
          This Agreement remains in effect until terminated. Access may be revoked immediately
          for policy violations or unauthorized use.
        </p>

        <h2 className="text-xl">9. Contact</h2>
        <p>
          For questions about this Agreement, contact Olympic Equipment system administration.
        </p>
      </section>
    </main>
  );
}
