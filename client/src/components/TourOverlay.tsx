import { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { X, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import type { TourStep } from '@/hooks/useTour';

interface TourOverlayProps {
  isActive: boolean;
  step: TourStep;
  currentStep: number;
  totalSteps: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}

export function TourOverlay({
  isActive,
  step,
  currentStep,
  totalSteps,
  onNext,
  onPrev,
  onSkip,
}: TourOverlayProps) {
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive || !step?.target) return;

    const updatePosition = () => {
      const element = document.querySelector(step.target);
      if (!element) return;

      const rect = element.getBoundingClientRect();
      const padding = 8;
      
      setPosition({
        top: rect.top - padding + window.scrollY,
        left: rect.left - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
      });

      const tooltipWidth = 320;
      const tooltipHeight = 180;
      const placement = step.placement || 'bottom';
      
      let tooltipTop = 0;
      let tooltipLeft = 0;

      switch (placement) {
        case 'top':
          tooltipTop = rect.top + window.scrollY - tooltipHeight - 16;
          tooltipLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
          break;
        case 'bottom':
          tooltipTop = rect.bottom + window.scrollY + 16;
          tooltipLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
          break;
        case 'left':
          tooltipTop = rect.top + window.scrollY + rect.height / 2 - tooltipHeight / 2;
          tooltipLeft = rect.left - tooltipWidth - 16;
          break;
        case 'right':
          tooltipTop = rect.top + window.scrollY + rect.height / 2 - tooltipHeight / 2;
          tooltipLeft = rect.right + 16;
          break;
      }

      tooltipLeft = Math.max(16, Math.min(tooltipLeft, window.innerWidth - tooltipWidth - 16));
      tooltipTop = Math.max(16, tooltipTop);

      setTooltipStyle({
        position: 'absolute',
        top: tooltipTop,
        left: tooltipLeft,
        width: tooltipWidth,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition);
    };
  }, [isActive, step]);

  if (!isActive || !step) return null;

  return (
    <div className="fixed inset-0 z-[100]" data-testid="tour-overlay">
      <div 
        className="absolute inset-0 bg-black/60 transition-opacity"
        onClick={onSkip}
      />
      
      <div
        className="absolute rounded-lg ring-4 ring-primary ring-offset-2 ring-offset-background transition-all duration-300 pointer-events-none"
        style={{
          top: position.top,
          left: position.left,
          width: position.width,
          height: position.height,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)',
          backgroundColor: 'transparent',
        }}
      />

      <div
        ref={tooltipRef}
        className="bg-card border border-border rounded-xl shadow-2xl p-4 z-[101]"
        style={tooltipStyle}
        data-testid="tour-tooltip"
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <h3 className="font-semibold text-foreground">{step.title}</h3>
          </div>
          <button 
            onClick={onSkip}
            className="p-1 rounded-md hover:bg-muted transition-colors"
            data-testid="tour-close"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        
        <p className="text-sm text-muted-foreground mb-4 leading-relaxed whitespace-pre-line">
          {step.content}
        </p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === currentStep ? 'bg-primary' : 'bg-muted-foreground/30'
                }`}
              />
            ))}
          </div>
          
          <div className="flex items-center gap-2">
            {currentStep > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onPrev}
                className="gap-1"
                data-testid="tour-prev"
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </Button>
            )}
            <Button
              size="sm"
              onClick={onNext}
              className="gap-1"
              data-testid="tour-next"
            >
              {currentStep === totalSteps - 1 ? 'Finish' : 'Next'}
              {currentStep < totalSteps - 1 && <ChevronRight className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        
        <div className="text-xs text-muted-foreground mt-3 text-center">
          Step {currentStep + 1} of {totalSteps}
        </div>
      </div>
    </div>
  );
}
