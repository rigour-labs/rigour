import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props { children: React.ReactNode; resetKey: string; }
interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State { return { error }; }

    componentDidUpdate(previous: Props): void {
        if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
    }

    render(): React.ReactNode {
        if (!this.state.error) return this.props.children;
        return (
            <div className="empty-state glass-card" role="alert">
                <AlertTriangle size={48} />
                <h3>This view could not be displayed</h3>
                <p>{this.state.error.message || 'Studio received data it could not render.'}</p>
                <button className="refresh-btn" type="button" onClick={() => this.setState({ error: null })}>
                    <RefreshCw size={16} /> Retry view
                </button>
            </div>
        );
    }
}
