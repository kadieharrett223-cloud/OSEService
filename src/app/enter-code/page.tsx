import { APP_NAME } from "@/lib/constants";
import { enterCodeAction } from "@/app/enter-code/actions";

export default async function EnterCodePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="min-h-screen bg-[linear-gradient(165deg,#fafafa_0%,#f2f2f2_45%,#ececec_100%)] px-4 py-12">
      <div className="mx-auto flex w-full max-w-4xl overflow-hidden rounded-2xl border border-[#e0e0e0] bg-white shadow-sm">
        <section className="hidden w-1/2 bg-[#111111] p-8 text-white md:block">
          <p className="text-sm uppercase tracking-[0.15em] text-[#f1b5b8]">Olympic Equipment</p>
          <h1 className="mt-3 text-4xl leading-tight">Customer Service Tracker</h1>
          <p className="mt-6 text-base text-[#d6d6d6]">
            Enter your name and the shared access code to continue.
          </p>
        </section>

        <section className="w-full p-6 md:w-1/2 md:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.12em] text-[#b20610]">{APP_NAME}</p>
          <h2 className="mt-2 text-3xl">Enter Access Code</h2>
          <p className="mt-2 text-sm text-[#5a5a5a]">Everyone uses one shared code. Name and access are logged.</p>

          {params.error ? (
            <p className="mt-4 rounded-md border border-[#f1bdc0] bg-[#fff3f4] p-3 text-sm text-[#8f030d]">
              {params.error}
            </p>
          ) : null}

          <form action={enterCodeAction} className="mt-6 space-y-4">
            <div>
              <label htmlFor="full_name" className="label">
                Your Name
              </label>
              <input id="full_name" name="full_name" required className="input" autoComplete="name" />
            </div>

            <div>
              <label htmlFor="access_code" className="label">
                Access Code
              </label>
              <input id="access_code" name="access_code" required className="input" autoComplete="off" />
            </div>

            <button type="submit" className="btn-primary w-full">
              Continue
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
