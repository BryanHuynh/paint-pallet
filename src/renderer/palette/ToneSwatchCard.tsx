import React, { useEffect, useId, useState } from 'react';
import { normalizeHex } from './colorMath';
import styles from './PaletteWorkspace.module.css';
import type { SwatchEntry, ToneSlot } from './types';

interface ToneSwatchCardProps {
  slot: ToneSlot;
  label: string;
  swatch: SwatchEntry;
  isSelected: boolean;
  onSelectTone: (slot: ToneSlot) => void;
  onChangeSwatch: (slot: ToneSlot, patch: Partial<SwatchEntry>) => void;
}

export function ToneSwatchCard({
  slot,
  label,
  swatch,
  isSelected,
  onSelectTone,
  onChangeSwatch,
}: ToneSwatchCardProps): React.ReactElement {
  const baseId = useId();
  const [hexDraft, setHexDraft] = useState(swatch.hex);
  const [hexError, setHexError] = useState<string | null>(null);

  useEffect(() => {
    setHexDraft(swatch.hex);
    setHexError(null);
  }, [swatch.hex]);

  function handleHexChange(raw: string) {
    setHexDraft(raw);
    const normalized = normalizeHex(raw);
    if (normalized) {
      setHexError(null);
      onChangeSwatch(slot, { hex: normalized });
    }
  }

  function handleHexBlur() {
    const normalized = normalizeHex(hexDraft);
    if (normalized) {
      setHexDraft(normalized);
      setHexError(null);
      if (normalized !== swatch.hex) {
        onChangeSwatch(slot, { hex: normalized });
      }
      return;
    }
    setHexDraft(swatch.hex);
    setHexError('Enter a 6-digit hex color such as #3A4F6A.');
  }

  return (
    <div
      className={`${styles.toneCard} ${isSelected ? styles.toneCardActive : ''}`}
    >
      <div className={styles.toneHeader}>
        <button
          type="button"
          className={styles.toneBtn}
          aria-pressed={isSelected}
          onClick={() => onSelectTone(slot)}
        >
          <span
            className={styles.swatchChip}
            style={{ backgroundColor: swatch.hex }}
            aria-hidden="true"
          />
          <span>{label}</span>
        </button>

        <div className={styles.hexField}>
          <label className={styles.label} htmlFor={`${baseId}-picker`}>
            Pick
          </label>
          <input
            id={`${baseId}-picker`}
            className={styles.colorPicker}
            type="color"
            value={swatch.hex}
            onChange={(event) => {
              const nextHex = event.target.value.toUpperCase();
              setHexDraft(nextHex);
              setHexError(null);
              onChangeSwatch(slot, { hex: nextHex });
            }}
          />
          <label className={styles.label} htmlFor={`${baseId}-hex`}>
            {label} hex
          </label>
          <input
            id={`${baseId}-hex`}
            className={styles.hexInput}
            type="text"
            value={hexDraft}
            onChange={(event) => handleHexChange(event.target.value)}
            onBlur={handleHexBlur}
          />
        </div>
      </div>

      {hexError && (
        <p className={styles.errorBanner} role="alert">
          {hexError}
        </p>
      )}

      <div className={styles.metaGrid}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${baseId}-brand`}>
            {label} brand
          </label>
          <input
            id={`${baseId}-brand`}
            className={styles.input}
            type="text"
            value={swatch.brand}
            onChange={(event) =>
              onChangeSwatch(slot, { brand: event.target.value })
            }
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${baseId}-bottle`}>
            {label} bottle name
          </label>
          <input
            id={`${baseId}-bottle`}
            className={styles.input}
            type="text"
            value={swatch.bottleName}
            onChange={(event) =>
              onChangeSwatch(slot, { bottleName: event.target.value })
            }
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${baseId}-notes`}>
          {label} mix notes
        </label>
        <textarea
          id={`${baseId}-notes`}
          className={styles.textarea}
          value={swatch.mixNotes}
          onChange={(event) =>
            onChangeSwatch(slot, { mixNotes: event.target.value })
          }
        />
      </div>
    </div>
  );
}
