export default function LoadingShippingGroups() {
  return (
    <main className="p-6" role="status">
      <h1 className="text-2xl font-semibold">Suggested Shipping Groups</h1>
      <p className="mt-3 animate-pulse motion-reduce:animate-none">
        Checking invoice destinations and existing lift availability… No
        inventory is being changed.
      </p>
    </main>
  );
}
