import { useEffect, useState } from "react";
import { api } from "./api";
import { AnalystDrawer } from "./components/AnalystDrawer";
import { ConfirmDestructive } from "./components/Dialogs";
import { Icon, ToastProvider, useToast } from "./components/ui";
import { AwardPage } from "./pages/Award";
import { ComparisonPage } from "./pages/Comparison";
import { LogPage } from "./pages/Log";
import { TracePage } from "./pages/Trace";
import { VendorPage } from "./pages/Vendor";

/** Hash routes: #/comparison, #/vendor/V1, #/award, #/log, #/trace/V1[/L06]. The data set is chosen in the top bar. */
function useHash(): string {
  const [hash, setHash] = useState(window.location.hash || "#/comparison");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/comparison");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const SET_LABEL: Record<string, string> = { tuned: "Demo set", holdout: "Holdout, seed 7", holdout2: "Fresh holdout, seed 8" };

function Shell() {
  const hash = useHash();
  const toast = useToast();
  const [sets, setSets] = useState<{ set: string; vendors: number }[]>([]);
  const [set, setSet] = useState(() => localStorage.getItem("qk.set") ?? "tuned");
  const [version, setVersion] = useState(0); // bumped when a buyer decision changes the data
  const [error, setError] = useState<string | null>(null);
  const [analyst, setAnalyst] = useState(false);
  const [openCell, setOpenCell] = useState<{ vendor: string; line: string } | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    api.sets().then(setSets).catch((e: Error) => setError(`${e.message}. Is the API running (npm run api)?`));
  }, []);
  useEffect(() => localStorage.setItem("qk.set", set), [set]);

  const route = hash.replace(/^#\//, "").split("/");
  // A link straight to one cell: #/comparison/V4/L04 opens its panel.
  useEffect(() => {
    if (route[0] === "comparison" && route[1] && route[2]) setOpenCell({ vendor: route[1], line: route[2] });
    // #/ask opens the analyst over the comparison.
    if (route[0] === "ask") {
      setAnalyst(true);
      window.location.hash = "#/comparison";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);
  const changed = (message?: string) => {
    setVersion((v) => v + 1);
    if (message) toast(message);
  };
  const tab = (id: string, label: string, icon: () => JSX.Element, active: boolean) => (
    <a href={`#/${id}`} className={active ? "active" : ""}>{icon()} {label}</a>
  );

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="logo">Q</div>
          <div>
            <div className="brand-name">QuoteKill</div>
            <div className="brand-sub">Kaveri Home Appliances · KHA-PKG-FY26-27</div>
          </div>
        </div>
        <nav className="nav">
          {tab("comparison", "Comparison", Icon.grid, route[0] === "comparison" || route[0] === "vendor" || route[0] === "")}
          {tab("award", "Award", Icon.award, route[0] === "award")}
          {tab("log", "Audit log", Icon.log, route[0] === "log")}
        </nav>
        <span className="spacer" />
        <label className="setpick">
          Data
          <select value={set} onChange={(e) => setSet(e.target.value)}>
            {(sets.length ? sets : [{ set, vendors: 0 }]).map((s) => <option key={s.set} value={s.set}>{SET_LABEL[s.set] ?? s.set}</option>)}
          </select>
        </label>
        <button className="btn ghost small" title="Remove every stored decision for this data set" onClick={() => setResetting(true)}>{Icon.reset()} Reset</button>
        <button className="btn primary" onClick={() => setAnalyst(!analyst)}>{Icon.spark()} {analyst ? "Hide analyst" : "Ask the analyst"}</button>
      </header>
      {error && <div className="page"><div className="error">{error}</div></div>}
      <div className={analyst ? "with-drawer-wrap" : ""} style={analyst ? { marginRight: "min(520px, 100vw)" } : undefined}>
        {route[0] === "vendor" && route[1] ? (
          <VendorPage set={set} vendorId={route[1]} version={version} onChanged={changed} />
        ) : route[0] === "award" ? (
          <AwardPage set={set} version={version} onChanged={changed} />
        ) : route[0] === "log" ? (
          <LogPage set={set} version={version} />
        ) : route[0] === "trace" && route[1] ? (
          <TracePage set={set} vendorId={route[1]} line={route[2] ?? null} />
        ) : (
          <ComparisonPage set={set} version={version} onChanged={changed} openCell={openCell} onCellOpened={() => setOpenCell(null)} />
        )}
      </div>
      {resetting && (
        <ConfirmDestructive
          title="Reset every decision?"
          explain="This removes every confirmation, verification, rate you entered, gate waiver, confirmed award and the audit log for this data set. The documents and their readings stay."
          action="Reset decisions"
          onYes={() => api.reset(set).then(() => changed("All decisions for this data set removed"))}
          onClose={() => setResetting(false)}
        />
      )}
      {analyst && (
        <AnalystDrawer
          set={set}
          onClose={() => setAnalyst(false)}
          onOpenCell={(vendor, line) => {
            window.location.hash = "#/comparison";
            setOpenCell({ vendor, line });
          }}
        />
      )}
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
