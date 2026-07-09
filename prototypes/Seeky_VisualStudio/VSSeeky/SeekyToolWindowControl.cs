using Microsoft.VisualStudio.Extensibility.UI;

namespace VSSeeky;

internal sealed class SeekyToolWindowControl : RemoteUserControl
{
    public SeekyToolWindowControl(object? dataContext, SynchronizationContext? synchronizationContext = null)
        : base(dataContext, synchronizationContext)
    {
    }
}
