import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Sequence } from '../lib/projectDocument';
import ProjectCanvasSettings from './ProjectCanvasSettings';

const sequence: Sequence = {
  id: 'sequence-test', name: 'Sequence 01', width: 320, height: 180,
  frameRate: { numerator: 30, denominator: 1 }, audioSampleRate: 48_000, durationFrames: 0, tracks: [],
};

describe('ProjectCanvasSettings', () => {
  it('submits custom dimensions, composition, and background through the parent callback', () => {
    const onApply = vi.fn();
    render(<ProjectCanvasSettings sequence={sequence} onApply={onApply} idPrefix="test-canvas" />);

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '234' } });
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '146' } });
    fireEvent.change(screen.getByLabelText('Source composition'), { target: { value: 'fill' } });
    fireEvent.change(screen.getByLabelText('Canvas background'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply canvas settings' }));

    expect(onApply).toHaveBeenCalledWith(234, 146, 'fill', '#123456');
  });
});
