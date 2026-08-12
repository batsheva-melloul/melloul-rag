// Dropdown to choose which chatbot/corpus is active.

function CorpusPicker({ corpora, selectedId, onSelect }) {
  if (!corpora || corpora.length === 0) {
    return null;
  }

  return (
    <div className="corpus-picker">
      <label className="corpus-picker-label">מאגר</label>
      <select
        className="corpus-select"
        value={selectedId || ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        {corpora.map((corpus) => (
          <option key={corpus.id} value={corpus.id}>
            {corpus.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export default CorpusPicker;