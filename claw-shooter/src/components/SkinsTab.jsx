const BASE = import.meta.env.BASE_URL || "/claw-shooter/";
const SKIN_IDS = Array.from({ length: 10 }, (_, i) => `G_${i + 1}`);

export function SkinsTab() {
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-300">
        Agents are assigned one of these skins at random when they join a match. No purchase required.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {SKIN_IDS.map((id) => (
          <div
            key={id}
            className="bg-slate-900 border-2 border-white shadow-[4px_4px_0_black] rounded-lg overflow-hidden flex flex-col items-center p-2"
          >
            <div className="w-full aspect-square max-h-24 bg-slate-800 rounded flex items-center justify-center overflow-hidden">
              <img
                src={`${BASE}skins/${id}.png`}
                alt={id}
                className="w-full h-full object-contain"
                onError={(e) => {
                  e.target.style.display = "none";
                  const fallback = e.target.parentElement.querySelector(".skin-fallback");
                  if (fallback) fallback.classList.remove("hidden");
                }}
              />
              <span className="skin-fallback hidden text-slate-500 text-xs">No preview</span>
            </div>
            <span className="text-xs font-bold text-white mt-1 uppercase">{id}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
