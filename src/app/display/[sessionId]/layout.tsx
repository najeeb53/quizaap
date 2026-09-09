export default function DisplayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center overflow-hidden">
      {children}
    </div>
  );
}