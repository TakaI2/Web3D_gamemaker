import FpsViewport from './components/FpsViewport.svelte';

new FpsViewport({
  target: document.getElementById('app') as HTMLElement,
  props: {
    onBack: () => { window.location.href = '../'; },
  },
});
