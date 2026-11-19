import { Navigate, useParams } from 'react-router-dom';
import { useStudioStore } from '@asvs/state';
import { NotFoundPage } from './not-found-page';

export function VideoRedirect() {
  const { videoId = '' } = useParams();
  const video = useStudioStore((state) => state.videos.find((item) => item.id === videoId));

  if (!video) return <NotFoundPage />;

  if (['draft', 'planning', 'script_review'].includes(video.stage)) {
    return <Navigate to={`/videos/${video.id}/director`} replace />;
  }
  if (video.stage === 'storyboard_ready') {
    return <Navigate to={`/videos/${video.id}/storyboard`} replace />;
  }
  if (video.stage === 'producing') {
    return <Navigate to={`/videos/${video.id}/production`} replace />;
  }
  return <Navigate to={`/videos/${video.id}/review`} replace />;
}
